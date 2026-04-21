/**
 * Webhook storage + template rendering for the admin API.
 *
 * Persisted to a single JSON file at store/webhook.json. Loaded lazily, written
 * synchronously on every mutation — single-process admin API has no concurrency
 * to worry about.
 */

import fs from 'fs';
import path from 'path';

import { STORE_DIR } from './config.js';

export interface WebhookTemplate {
  id: string;
  template: string;
  description?: string;
}

export interface WebhookConfig {
  allowlist: string[];
  templates: Record<string, WebhookTemplate>;
}

const STORE_PATH = path.join(STORE_DIR, 'webhook.json');

const EMPTY: WebhookConfig = { allowlist: [], templates: {} };

function read(): WebhookConfig {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<WebhookConfig>;
    return {
      allowlist: Array.isArray(parsed.allowlist) ? parsed.allowlist : [],
      templates:
        parsed.templates && typeof parsed.templates === 'object'
          ? parsed.templates
          : {},
    };
  } catch {
    return { ...EMPTY, templates: {} };
  }
}

function write(cfg: WebhookConfig): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

export function getWebhookConfig(): WebhookConfig {
  return read();
}

export function isJidAllowed(jid: string): boolean {
  return read().allowlist.includes(jid);
}

export function setAllowlist(jids: string[]): WebhookConfig {
  const unique = Array.from(
    new Set(jids.filter((j) => typeof j === 'string' && j.trim())),
  );
  const cfg = read();
  cfg.allowlist = unique;
  write(cfg);
  return cfg;
}

export function addAllowedJid(jid: string): WebhookConfig {
  const cfg = read();
  if (!cfg.allowlist.includes(jid)) cfg.allowlist.push(jid);
  write(cfg);
  return cfg;
}

export function removeAllowedJid(jid: string): WebhookConfig {
  const cfg = read();
  cfg.allowlist = cfg.allowlist.filter((j) => j !== jid);
  write(cfg);
  return cfg;
}

export function upsertTemplate(tpl: WebhookTemplate): WebhookConfig {
  if (!tpl.id || !tpl.template) {
    throw new Error('template id and body are required');
  }
  const cfg = read();
  cfg.templates[tpl.id] = {
    id: tpl.id,
    template: tpl.template,
    description: tpl.description,
  };
  write(cfg);
  return cfg;
}

export function deleteTemplate(id: string): WebhookConfig {
  const cfg = read();
  delete cfg.templates[id];
  write(cfg);
  return cfg;
}

/**
 * Mustache-lite: replaces `{{name}}` occurrences with values[name].
 * Missing variables render as empty string (no error).
 */
export function renderTemplate(
  template: string,
  variables: Record<string, unknown> = {},
): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
    const v = variables[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

export interface ResolvedMessage {
  jid: string;
  text: string;
}

export interface WebhookResolutionError {
  status: number;
  error: string;
  detail?: string;
}

/**
 * Resolve a webhook request body into a concrete message.
 * Returns either { ok: true, ... } or { ok: false, error, status }.
 */
export function resolveWebhookRequest(
  body: Record<string, unknown>,
):
  | { ok: true; message: ResolvedMessage }
  | { ok: false; error: WebhookResolutionError } {
  const jid = typeof body.jid === 'string' ? body.jid.trim() : '';
  if (!jid) {
    return {
      ok: false,
      error: { status: 400, error: 'missing_jid' },
    };
  }

  if (!isJidAllowed(jid)) {
    return {
      ok: false,
      error: { status: 403, error: 'jid_not_in_allowlist', detail: jid },
    };
  }

  if (typeof body.message === 'string' && body.message.trim()) {
    return { ok: true, message: { jid, text: body.message } };
  }

  if (typeof body.template_id === 'string' && body.template_id) {
    const cfg = read();
    const tpl = cfg.templates[body.template_id];
    if (!tpl) {
      return {
        ok: false,
        error: {
          status: 404,
          error: 'template_not_found',
          detail: body.template_id,
        },
      };
    }
    const vars =
      body.variables && typeof body.variables === 'object'
        ? (body.variables as Record<string, unknown>)
        : {};
    return {
      ok: true,
      message: { jid, text: renderTemplate(tpl.template, vars) },
    };
  }

  return {
    ok: false,
    error: { status: 400, error: 'missing_message_or_template_id' },
  };
}
