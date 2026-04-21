import http from 'http';
import fs from 'fs';
import path from 'path';

import {
  ADMIN_PORT,
  ASSISTANT_HAS_OWN_NUMBER,
  ASSISTANT_NAME,
  DATA_DIR,
  DEFAULT_TRIGGER,
  STORE_DIR,
  TIMEZONE,
} from './config.js';
import { getRegisteredChannelNames } from './channels/registry.js';
import type { WhatsAppChannel } from './channels/whatsapp.js';
import { getAllChats, getAllRegisteredGroups } from './db.js';
import { logger } from './logger.js';
import { findChannel } from './router.js';
import { Channel } from './types.js';
import {
  addAllowedJid,
  deleteTemplate,
  getWebhookConfig,
  removeAllowedJid,
  resolveWebhookRequest,
  setAllowlist,
  upsertTemplate,
} from './webhook.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

const UI_DIR = path.resolve(process.cwd(), '.claude/skills/add-admin-ui/ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function findWhatsApp(channels: Channel[]): WhatsAppChannel | undefined {
  return channels.find((c) => c.name === 'whatsapp') as
    | WhatsAppChannel
    | undefined;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

function serveStatic(res: http.ServerResponse, relPath: string): void {
  const cleaned = relPath.replace(/^\/+/, '').replace(/\.\.+/g, '');
  const target = cleaned === '' ? 'index.html' : cleaned;
  const full = path.resolve(UI_DIR, target);
  if (!full.startsWith(UI_DIR) || !fs.existsSync(full)) {
    res.writeHead(404).end();
    return;
  }
  const ext = path.extname(full).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  const data = fs.readFileSync(full);
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': data.length.toString(),
  });
  res.end(data);
}

async function readJsonBody(
  req: http.IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 256 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          resolve(parsed as Record<string, unknown>);
        } else {
          reject(new Error('body must be a JSON object'));
        }
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

async function handleWebhook(
  method: string,
  apiPath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  channels: Channel[],
): Promise<void> {
  // POST /webhook — deliver a message
  if (apiPath === '/webhook' && method === 'POST') {
    const body = await readJsonBody(req);
    const resolved = resolveWebhookRequest(body);
    if (!resolved.ok) {
      json(res, resolved.error.status, {
        error: resolved.error.error,
        detail: resolved.error.detail,
      });
      return;
    }
    const { jid, text } = resolved.message;
    const channel = findChannel(channels, jid);
    if (!channel) {
      json(res, 503, { error: 'no_channel_for_jid', detail: jid });
      return;
    }
    if (!channel.isConnected()) {
      json(res, 503, { error: 'channel_not_connected', detail: channel.name });
      return;
    }
    await channel.sendMessage(jid, text);
    logger.info(
      { jid, channel: channel.name, length: text.length },
      'webhook delivered',
    );
    json(res, 200, {
      ok: true,
      jid,
      channel: channel.name,
      bytes: text.length,
    });
    return;
  }

  // GET /webhook — config snapshot
  if (apiPath === '/webhook' && method === 'GET') {
    json(res, 200, getWebhookConfig());
    return;
  }

  // Allowlist CRUD
  if (apiPath === '/webhook/allowlist' && method === 'GET') {
    json(res, 200, getWebhookConfig().allowlist);
    return;
  }
  if (apiPath === '/webhook/allowlist' && method === 'PUT') {
    const body = await readJsonBody(req);
    const jids = Array.isArray(body.jids) ? (body.jids as string[]) : [];
    const cfg = setAllowlist(jids);
    json(res, 200, cfg.allowlist);
    return;
  }
  const allowMatch = apiPath.match(/^\/webhook\/allowlist\/(.+)$/);
  if (allowMatch) {
    const jid = decodeURIComponent(allowMatch[1]);
    if (method === 'POST') {
      const cfg = addAllowedJid(jid);
      json(res, 200, cfg.allowlist);
      return;
    }
    if (method === 'DELETE') {
      const cfg = removeAllowedJid(jid);
      json(res, 200, cfg.allowlist);
      return;
    }
    json(res, 405, { error: 'method_not_allowed' });
    return;
  }

  // Template CRUD
  if (apiPath === '/webhook/templates' && method === 'GET') {
    json(res, 200, getWebhookConfig().templates);
    return;
  }
  const tplMatch = apiPath.match(/^\/webhook\/templates\/(.+)$/);
  if (tplMatch) {
    const id = decodeURIComponent(tplMatch[1]);
    if (method === 'PUT') {
      const body = await readJsonBody(req);
      const template = typeof body.template === 'string' ? body.template : '';
      const description =
        typeof body.description === 'string' ? body.description : undefined;
      if (!template) {
        json(res, 400, { error: 'missing_template' });
        return;
      }
      const cfg = upsertTemplate({ id, template, description });
      json(res, 200, cfg.templates[id]);
      return;
    }
    if (method === 'DELETE') {
      deleteTemplate(id);
      json(res, 200, { ok: true, id });
      return;
    }
    json(res, 405, { error: 'method_not_allowed' });
    return;
  }

  json(res, 404, { error: 'not_found', path: apiPath });
}

async function handleApi(
  apiPath: string,
  channels: Channel[],
  res: http.ServerResponse,
): Promise<void> {
  if (apiPath === '/channels') {
    json(
      res,
      200,
      channels.map((c) => ({ name: c.name, connected: c.isConnected() })),
    );
    return;
  }

  if (apiPath === '/groups') {
    const wa = findWhatsApp(channels);
    if (!wa || !wa.isConnected()) {
      json(res, 503, { error: 'whatsapp_not_connected' });
      return;
    }
    const groups = await wa.listGroups();
    const summary = Object.entries(groups).map(([jid, g]) => ({
      jid,
      subject: g.subject,
      size: g.size ?? g.participants?.length,
      creation: g.creation,
      desc: g.desc,
      owner: g.owner,
      announce: g.announce,
      restrict: g.restrict,
    }));
    json(res, 200, summary);
    return;
  }

  const groupMatch = apiPath.match(/^\/groups\/(.+)$/);
  if (groupMatch) {
    const wa = findWhatsApp(channels);
    if (!wa || !wa.isConnected()) {
      json(res, 503, { error: 'whatsapp_not_connected' });
      return;
    }
    const jid = decodeURIComponent(groupMatch[1]);
    const metadata = await wa.getGroupMetadata(jid);
    if (!metadata) {
      json(res, 404, { error: 'group_not_found', jid });
      return;
    }
    json(res, 200, metadata);
    return;
  }

  if (apiPath === '/chats') {
    json(res, 200, getAllChats());
    return;
  }

  if (apiPath === '/registered') {
    json(res, 200, getAllRegisteredGroups());
    return;
  }

  if (apiPath === '/config') {
    json(res, 200, {
      assistantName: ASSISTANT_NAME,
      assistantHasOwnNumber: ASSISTANT_HAS_OWN_NUMBER,
      defaultTrigger: DEFAULT_TRIGGER,
      timezone: TIMEZONE,
      storeDir: STORE_DIR,
      dataDir: DATA_DIR,
      installedChannels: getRegisteredChannelNames(),
      adminPort: ADMIN_PORT,
    });
    return;
  }

  json(res, 404, { error: 'not_found', path: apiPath });
}

export function startAdminServer(channels: Channel[]): http.Server {
  const server = http.createServer(async (req, res) => {
    const remote = req.socket.remoteAddress || '';
    if (!LOOPBACK.has(remote)) {
      res.writeHead(403).end();
      return;
    }

    const method = req.method || 'GET';
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    try {
      if (pathname.startsWith('/api/webhook')) {
        await handleWebhook(method, pathname.slice(4), req, res, channels);
        return;
      }

      if (method !== 'GET') {
        json(res, 405, { error: 'method_not_allowed' });
        return;
      }

      if (pathname.startsWith('/api/')) {
        await handleApi(pathname.slice(4), channels, res);
        return;
      }

      if (pathname === '/' || pathname === '/index.html') {
        serveStatic(res, 'index.html');
        return;
      }
      serveStatic(res, pathname);
    } catch (err) {
      logger.error({ err, path: pathname }, 'admin server request failed');
      json(res, 500, {
        error: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  server.listen(ADMIN_PORT, '127.0.0.1', () => {
    logger.info(
      { port: ADMIN_PORT, url: `http://127.0.0.1:${ADMIN_PORT}` },
      'admin UI listening on 127.0.0.1',
    );
  });

  server.on('error', (err) => {
    logger.error({ err, port: ADMIN_PORT }, 'admin server error');
  });

  return server;
}
