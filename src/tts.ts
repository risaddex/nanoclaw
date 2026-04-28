/**
 * Local TTS Integration - Host-side IPC Handler
 *
 * Converts text → speech on the host via macOS `say` (or any configured
 * TTS_COMMAND), re-encodes to OGG/Opus via ffmpeg, and sends the result as
 * a WhatsApp voice note (ptt=true) using the running Baileys socket.
 *
 * Container-side MCP tool lives in agent.ts.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { TTS_COMMAND, TTS_LANGUAGE, TTS_RATE, TTS_VOICE } from './config.js';
import { logger } from './logger.js';

interface SkillResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export type HostSendAudio = (jid: string, buffer: Buffer) => Promise<void>;

// Heuristic fallback voices if TTS_VOICE is unset. Only used with macOS `say`.
const DEFAULT_VOICE_BY_LANG: Record<string, string> = {
  pt_BR: 'Luciana',
  pt_PT: 'Joana',
  en_US: 'Samantha',
  en_GB: 'Daniel',
  es_ES: 'Monica',
  es_MX: 'Paulina',
  fr_FR: 'Thomas',
  de_DE: 'Anna',
  it_IT: 'Alice',
  ja_JP: 'Kyoko',
};

function pickVoice(override?: string): string {
  if (override && override.trim()) return override.trim();
  if (TTS_VOICE) return TTS_VOICE;
  return DEFAULT_VOICE_BY_LANG[TTS_LANGUAGE] || '';
}

function runCmd(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    const timer = setTimeout(() => proc.kill('SIGTERM'), opts.timeoutMs ?? 120_000);
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', () => {
      clearTimeout(timer);
      resolve({ ok: false, stderr: stderr || `spawn error for ${cmd}` });
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stderr });
    });
  });
}

async function synthesizeToOgg(
  text: string,
  opts: { voice?: string; rate?: string },
): Promise<{ ok: true; buffer: Buffer } | { ok: false; message: string }> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-tts-'));
  const rawPath = path.join(tmpDir, 'raw.aiff');
  const oggPath = path.join(tmpDir, 'out.ogg');

  try {
    // 1) text → raw audio via `say`
    const voice = pickVoice(opts.voice);
    const rate = (opts.rate || TTS_RATE).trim();
    const sayArgs: string[] = [];
    if (voice) sayArgs.push('-v', voice);
    if (rate) sayArgs.push('-r', rate);
    sayArgs.push('-o', rawPath, '--', text);

    const sayRes = await runCmd(TTS_COMMAND, sayArgs, { timeoutMs: 60_000 });
    if (!sayRes.ok || !fs.existsSync(rawPath)) {
      return {
        ok: false,
        message: `${TTS_COMMAND} failed: ${sayRes.stderr.slice(0, 300) || 'unknown error'}`,
      };
    }

    // 2) raw → ogg/opus mono 16 kHz (WhatsApp PTT format)
    const ffRes = await runCmd(
      'ffmpeg',
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        rawPath,
        '-c:a',
        'libopus',
        '-b:a',
        '24k',
        '-ar',
        '16000',
        '-ac',
        '1',
        oggPath,
      ],
      { timeoutMs: 60_000 },
    );
    if (!ffRes.ok || !fs.existsSync(oggPath)) {
      return {
        ok: false,
        message: `ffmpeg failed: ${ffRes.stderr.slice(0, 300) || 'unknown error'}`,
      };
    }

    const buffer = fs.readFileSync(oggPath);
    return { ok: true, buffer };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* ignore cleanup errors */
    }
  }
}

function writeResult(dataDir: string, sourceGroup: string, requestId: string, result: SkillResult): void {
  const resultsDir = path.join(dataDir, 'ipc', sourceGroup, 'tts_results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, `${requestId}.json`), JSON.stringify(result));
}

function resolveJidForFolder(
  sourceGroup: string,
  registeredGroups: Record<string, { jid: string; folder: string }>,
): string | undefined {
  for (const g of Object.values(registeredGroups)) {
    if (g.folder === sourceGroup) return g.jid;
  }
  return undefined;
}

export interface TtsIpcDeps {
  sendAudio: HostSendAudio;
  registeredGroups: () => Record<string, { jid: string; folder: string }>;
}

/**
 * Handle tts_* IPC messages. Returns true if handled.
 */
export async function handleTtsIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  _isMain: boolean,
  dataDir: string,
  deps: TtsIpcDeps,
): Promise<boolean> {
  const type = data.type as string;
  if (!type?.startsWith('tts_')) return false;

  const requestId = data.requestId as string | undefined;
  if (!requestId) {
    logger.warn({ type, sourceGroup }, 'tts: missing requestId');
    return true;
  }

  let result: SkillResult;
  try {
    if (type !== 'tts_reply') {
      result = { success: false, message: `unknown tts type: ${type}` };
    } else {
      const text = (data.text as string | undefined)?.trim();
      if (!text) {
        result = { success: false, message: 'missing text' };
      } else {
        const jid = (data.chatJid as string | undefined) || resolveJidForFolder(sourceGroup, deps.registeredGroups());
        if (!jid) {
          result = {
            success: false,
            message: `no registered jid for folder "${sourceGroup}"`,
          };
        } else {
          logger.info({ sourceGroup, jid, chars: text.length }, 'tts: synthesizing');
          const synth = await synthesizeToOgg(text, {
            voice: data.voice as string | undefined,
            rate: data.rate as string | undefined,
          });
          if (!synth.ok) {
            result = { success: false, message: synth.message };
          } else {
            await deps.sendAudio(jid, synth.buffer);
            result = {
              success: true,
              message: `sent voice note (${synth.buffer.length} bytes)`,
              data: { bytes: synth.buffer.length },
            };
          }
        }
      }
    }
  } catch (err) {
    result = {
      success: false,
      message: err instanceof Error ? err.message : String(err),
    };
    logger.error({ err, sourceGroup, requestId }, 'tts: unhandled error');
  }

  writeResult(dataDir, sourceGroup, requestId, result);
  if (result.success) {
    logger.info({ requestId, sourceGroup }, 'tts: delivered');
  } else {
    logger.warn({ requestId, sourceGroup, message: result.message }, 'tts: failed');
  }
  return true;
}
