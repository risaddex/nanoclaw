import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets are NOT read here — they stay on disk and are loaded only
// where needed (container-runner.ts) to avoid leaking to child processes.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;

// Serena HTTP bridge configuration
const serenaEnv = readEnvFile([
  'SERENA_MCP_URL',
  'SERENA_START_CMD',
  'SERENA_PROJECT_PATHS',
]);

export const SERENA_MCP_URL: string | undefined =
  process.env.SERENA_MCP_URL || serenaEnv.SERENA_MCP_URL || undefined;

export const SERENA_START_CMD: string | undefined =
  process.env.SERENA_START_CMD || serenaEnv.SERENA_START_CMD || undefined;

export const SERENA_PROJECT_PATHS_RAW: string | undefined =
  process.env.SERENA_PROJECT_PATHS ||
  serenaEnv.SERENA_PROJECT_PATHS ||
  undefined;

/**
 * Parse SERENA_PROJECT_PATHS="name:/host/path,name2:/host/path2" into a map.
 * Splits only on the first colon per entry so paths with colons are preserved.
 */
export function parseProjectPaths(
  raw: string | undefined,
): Map<string, string> {
  const result = new Map<string, string>();
  if (!raw) return result;
  for (const entry of raw.split(',')) {
    const colon = entry.indexOf(':');
    if (colon === -1) continue;
    const name = entry.slice(0, colon).trim();
    const hostPath = entry.slice(colon + 1).trim();
    if (name && hostPath) result.set(name, hostPath);
  }
  return result;
}
