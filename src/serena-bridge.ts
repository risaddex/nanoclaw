/**
 * Serena Bridge — manages the Serena HTTP MCP server process.
 *
 * If SERENA_START_CMD is configured, NanoClaw spawns Serena at startup
 * and restarts it if it crashes. If not configured, Serena is assumed
 * to be running externally (e.g., via VSCode extension).
 */
import { spawn, ChildProcess } from 'child_process';
import { SERENA_MCP_URL, SERENA_START_CMD } from './config.js';
import { logger } from './logger.js';

let serenaProcess: ChildProcess | null = null;
let stopped = false;

function spawnSerena(): void {
  if (!SERENA_START_CMD) return;

  const parts = SERENA_START_CMD.split(/\s+/);
  const cmd = parts[0];
  const args = parts.slice(1);

  logger.info({ cmd, args }, 'Starting Serena HTTP server');

  serenaProcess = spawn(cmd, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env },
  });

  serenaProcess.stdout?.on('data', (d: Buffer) =>
    logger.debug({ src: 'serena' }, d.toString().trim()),
  );
  serenaProcess.stderr?.on('data', (d: Buffer) =>
    logger.debug({ src: 'serena-err' }, d.toString().trim()),
  );

  serenaProcess.on('exit', (code, signal) => {
    logger.warn({ code, signal }, 'Serena process exited');
    serenaProcess = null;
    if (!stopped) {
      logger.info('Restarting Serena in 5s');
      setTimeout(spawnSerena, 5000);
    }
  });

  serenaProcess.on('error', (err) => {
    logger.error({ err }, 'Failed to start Serena process');
  });
}

export function startSerenaServer(): void {
  if (!SERENA_MCP_URL) return;
  if (SERENA_START_CMD) {
    spawnSerena();
  } else {
    logger.info(
      { url: SERENA_MCP_URL },
      'SERENA_MCP_URL set — assuming Serena is running externally',
    );
  }
}

export function stopSerenaServer(): void {
  stopped = true;
  if (serenaProcess) {
    logger.info('Stopping Serena process');
    serenaProcess.kill('SIGTERM');
    serenaProcess = null;
  }
}
