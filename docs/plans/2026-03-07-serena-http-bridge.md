# Serena HTTP Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable NanoClaw container agents to call Serena MCP tools (symbol navigation, code editing, memories) via an HTTP bridge on the host, so WhatsApp-triggered tasks can read and edit project code with full LSP support.

**Architecture:** Serena runs as a standalone HTTP/MCP server on the host (`127.0.0.1:8765`). NanoClaw optionally starts it at startup via `SERENA_START_CMD`. The container connects to it via `host.docker.internal:8765`, added to the container's `/etc/hosts`. Project directories are mounted read-only at `/workspace/extra/{name}/` for `Bash` operations. The agent calls `mcp__serena__activate_project` as its first step.

**Tech Stack:** TypeScript, Node.js `child_process`, Vitest, Serena CLI (`uv run serena-mcp-server`), Docker `--add-host`

---

## Task 1: Parse Serena config in `src/config.ts`

**Files:**
- Modify: `src/config.ts`
- Create: `src/config.test.ts`

**Step 1: Write the failing test**

Create `src/config.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseProjectPaths } from './config.js';

describe('parseProjectPaths', () => {
  it('returns empty map for undefined', () => {
    expect(parseProjectPaths(undefined)).toEqual(new Map());
  });

  it('parses a single entry', () => {
    const result = parseProjectPaths('myapp:/home/user/Work/myapp');
    expect(result.get('myapp')).toBe('/home/user/Work/myapp');
    expect(result.size).toBe(1);
  });

  it('parses multiple entries', () => {
    const result = parseProjectPaths('foo:/path/foo,bar:/path/bar');
    expect(result.get('foo')).toBe('/path/foo');
    expect(result.get('bar')).toBe('/path/bar');
  });

  it('ignores entries without colon', () => {
    const result = parseProjectPaths('bad-entry,good:/path');
    expect(result.size).toBe(1);
    expect(result.get('good')).toBe('/path');
  });

  it('trims whitespace around name and path', () => {
    const result = parseProjectPaths(' myapp : /home/user/Work/myapp ');
    expect(result.get('myapp')).toBe('/home/user/Work/myapp');
  });

  it('handles paths with colons (Windows-style or extra colons)', () => {
    // Only split on the FIRST colon
    const result = parseProjectPaths('proj:/path/with:colon');
    expect(result.get('proj')).toBe('/path/with:colon');
  });
});
```

**Step 2: Run test to verify it fails**

```bash
cd ~/Work/nanoclaw && npx vitest run src/config.test.ts
```

Expected: FAIL — `parseProjectPaths is not a function`

**Step 3: Add constants and function to `src/config.ts`**

Append after the last `export` line in `src/config.ts`:

```typescript
// Serena HTTP bridge configuration
const serenaEnv = readEnvFile(['SERENA_MCP_URL', 'SERENA_START_CMD', 'SERENA_PROJECT_PATHS']);

export const SERENA_MCP_URL: string | undefined =
  process.env.SERENA_MCP_URL || serenaEnv.SERENA_MCP_URL || undefined;

export const SERENA_START_CMD: string | undefined =
  process.env.SERENA_START_CMD || serenaEnv.SERENA_START_CMD || undefined;

export const SERENA_PROJECT_PATHS_RAW: string | undefined =
  process.env.SERENA_PROJECT_PATHS || serenaEnv.SERENA_PROJECT_PATHS || undefined;

/**
 * Parse SERENA_PROJECT_PATHS="name:/host/path,name2:/host/path2" into a map.
 * Splits only on the first colon per entry so paths with colons are preserved.
 */
export function parseProjectPaths(raw: string | undefined): Map<string, string> {
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
```

**Step 4: Run test to verify it passes**

```bash
cd ~/Work/nanoclaw && npx vitest run src/config.test.ts
```

Expected: PASS — all 6 tests green

**Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat(serena): add SERENA_MCP_URL/START_CMD/PROJECT_PATHS config parsing"
```

---

## Task 2: Create `src/serena-bridge.ts`

Manages the Serena HTTP server process lifecycle. If `SERENA_START_CMD` is set, NanoClaw spawns and monitors Serena. If not set, Serena is assumed to already be running.

**Files:**
- Create: `src/serena-bridge.ts`

No unit test for this task — it wraps `child_process.spawn` and is integration-only. Manual verification in Task 5.

**Step 1: Create `src/serena-bridge.ts`**

```typescript
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
```

**Step 2: Commit**

```bash
git add src/serena-bridge.ts
git commit -m "feat(serena): add Serena HTTP server lifecycle manager"
```

---

## Task 3: Add Serena URL and project mounts to `src/container-runner.ts`

**Files:**
- Modify: `src/container-runner.ts`
- Modify: `src/container-runner.test.ts`

Three changes:
1. Add `--add-host=host.docker.internal:host-gateway` when Serena is configured (Linux only)
2. Mount each project from `SERENA_PROJECT_PATHS` at `/workspace/extra/{name}/`
3. Pass `serenaMcpUrl` and `availableProjects` via `ContainerInput`

**Step 1: Extend `ContainerInput` interface**

In `src/container-runner.ts`, add two fields to the `ContainerInput` interface (around line 33):

```typescript
export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  serenaMcpUrl?: string;           // add this
  availableProjects?: string[];    // add this
}
```

**Step 2: Add project mounts to `buildVolumeMounts`**

At the end of `buildVolumeMounts`, before `return mounts`, add:

```typescript
  // Serena project mounts: each project in SERENA_PROJECT_PATHS → /workspace/extra/{name}/
  const projectPaths = parseProjectPaths(SERENA_PROJECT_PATHS_RAW);
  for (const [name, hostPath] of projectPaths) {
    const expandedPath = hostPath.replace(/^~/, process.env.HOME || os.homedir());
    if (fs.existsSync(expandedPath)) {
      mounts.push({
        hostPath: expandedPath,
        containerPath: `/workspace/extra/${name}`,
        readonly: true,
      });
    } else {
      logger.warn({ name, hostPath: expandedPath }, 'Serena project path not found, skipping mount');
    }
  }
```

Also add these imports at the top of `src/container-runner.ts` (near existing imports):

```typescript
import os from 'os';
import { parseProjectPaths, SERENA_PROJECT_PATHS_RAW, SERENA_MCP_URL } from './config.js';
```

**Step 3: Add `--add-host` and `SERENA_MCP_URL` env to `buildContainerArgs`**

In `buildContainerArgs`, after the existing `args.push(CONTAINER_IMAGE)` block (before `return args`):

Wait — insert BEFORE `args.push(CONTAINER_IMAGE)`:

```typescript
  // Serena bridge: allow container to reach host.docker.internal
  if (SERENA_MCP_URL) {
    args.push('--add-host=host.docker.internal:host-gateway');
    args.push('-e', `SERENA_MCP_URL=${SERENA_MCP_URL}`);
  }
```

**Step 4: Pass available projects in `runContainerAgent`**

In `runContainerAgent`, before writing the input to stdin (around line 313 `container.stdin.write`), set `input.serenaMcpUrl` and `input.availableProjects`:

```typescript
  // Inject Serena config into input
  if (SERENA_MCP_URL) {
    input.serenaMcpUrl = SERENA_MCP_URL;
    input.availableProjects = Array.from(parseProjectPaths(SERENA_PROJECT_PATHS_RAW).keys());
  }
  input.secrets = readSecrets();
  container.stdin.write(JSON.stringify(input));
  container.stdin.end();
  delete input.secrets;
  delete input.serenaMcpUrl;
  delete input.availableProjects;
```

**Step 5: Write tests for the new mount and arg behavior**

In `src/container-runner.test.ts`, add a new describe block (look for where to insert after existing tests):

```typescript
describe('Serena integration', () => {
  beforeEach(() => {
    // Override config mock for these tests
    vi.doMock('./config.js', () => ({
      CONTAINER_IMAGE: 'nanoclaw-agent:latest',
      CONTAINER_MAX_OUTPUT_SIZE: 10485760,
      CONTAINER_TIMEOUT: 1800000,
      DATA_DIR: '/tmp/nanoclaw-test-data',
      GROUPS_DIR: '/tmp/nanoclaw-test-groups',
      IDLE_TIMEOUT: 1800000,
      TIMEZONE: 'America/Sao_Paulo',
      SERENA_MCP_URL: 'http://host.docker.internal:8765/mcp',
      SERENA_PROJECT_PATHS_RAW: 'myapp:/home/user/Work/myapp',
      parseProjectPaths: (raw: string | undefined) => {
        const m = new Map<string, string>();
        if (!raw) return m;
        for (const entry of raw.split(',')) {
          const colon = entry.indexOf(':');
          if (colon === -1) continue;
          m.set(entry.slice(0, colon).trim(), entry.slice(colon + 1).trim());
        }
        return m;
      },
    }));
  });

  it('parseProjectPaths handles empty string', () => {
    // Inline test — no module reload needed
    const parse = (raw: string | undefined): Map<string, string> => {
      const m = new Map<string, string>();
      if (!raw) return m;
      for (const entry of raw.split(',')) {
        const colon = entry.indexOf(':');
        if (colon === -1) continue;
        m.set(entry.slice(0, colon).trim(), entry.slice(colon + 1).trim());
      }
      return m;
    };
    expect(parse('')).toEqual(new Map());
    expect(parse('a:/b')).toEqual(new Map([['a', '/b']]));
  });
});
```

Note: The mount/arg behavior is best verified via integration (Task 5). The pure unit tests for `parseProjectPaths` are already in Task 1.

**Step 6: Run existing tests to confirm no regressions**

```bash
cd ~/Work/nanoclaw && npx vitest run src/container-runner.test.ts
```

Expected: PASS — all existing tests still green

**Step 7: Commit**

```bash
git add src/container-runner.ts src/container-runner.test.ts
git commit -m "feat(serena): add project mounts and --add-host to container runner"
```

---

## Task 4: Start Serena in `src/index.ts`

**Files:**
- Modify: `src/index.ts`

**Step 1: Add import**

At the top of `src/index.ts`, with the other imports, add:

```typescript
import { startSerenaServer, stopSerenaServer } from './serena-bridge.js';
```

**Step 2: Call `startSerenaServer()` in `main()`**

In `main()`, after `ensureContainerSystemRunning()`:

```typescript
async function main(): Promise<void> {
  ensureContainerSystemRunning();
  startSerenaServer(); // ← add this line
  initDatabase();
  // ... rest unchanged
```

**Step 3: Add `stopSerenaServer()` to shutdown handler**

In the `shutdown` function:

```typescript
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    stopSerenaServer(); // ← add this line
    await queue.shutdown(10000);
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
```

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(serena): start/stop Serena server with NanoClaw lifecycle"
```

---

## Task 5: Add Serena MCP to container agent-runner

**Files:**
- Modify: `container/agent-runner/src/index.ts`

Three changes:
1. Read `serenaMcpUrl` and `availableProjects` from `ContainerInput`
2. Add Serena to `mcpServers` when URL present
3. Add `mcp__serena__*` to `allowedTools`
4. Inject available projects context into the system prompt

**Step 1: Update `ContainerInput` interface in agent-runner**

In `container/agent-runner/src/index.ts`, update the `ContainerInput` interface (around line 22):

```typescript
interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  secrets?: Record<string, string>;
  serenaMcpUrl?: string;        // add this
  availableProjects?: string[]; // add this
}
```

**Step 2: Build Serena system prompt context**

Add this helper function before `runQuery`:

```typescript
function buildSerenaContext(
  serenaMcpUrl: string | undefined,
  availableProjects: string[] | undefined,
): string | undefined {
  if (!serenaMcpUrl) return undefined;

  const lines: string[] = [
    '',
    '## Serena MCP Tools Available',
    '',
    'You have access to Serena MCP tools for intelligent code navigation and editing.',
    'Always call `mcp__serena__activate_project` FIRST to select the project you will work on.',
    '',
  ];

  if (availableProjects && availableProjects.length > 0) {
    lines.push('**Available projects:**');
    for (const name of availableProjects) {
      lines.push(`- \`${name}\` (mounted at \`/workspace/extra/${name}/\` for Bash)`);
    }
    lines.push('');
    lines.push('**Workflow:**');
    lines.push('1. Call `mcp__serena__activate_project("<project-name>")` to load the project');
    lines.push('2. Use `mcp__serena__find_symbol`, `mcp__serena__search_for_pattern`, etc. to explore code');
    lines.push('3. Use `mcp__serena__replace_symbol_body` or `mcp__serena__create_text_file` to edit');
    lines.push('4. Use `Bash` in `/workspace/extra/<project-name>/` to run tests or builds');
    lines.push('5. Use `mcp__serena__write_memory` to persist notes for future sessions');
  }

  return lines.join('\n');
}
```

**Step 3: Update `runQuery` to use Serena MCP**

In `runQuery`, update the `query()` options block:

```typescript
  // Build Serena MCP server config if URL is provided
  const serenaMcpUrl = containerInput.serenaMcpUrl;
  const serenaContext = buildSerenaContext(serenaMcpUrl, containerInput.availableProjects);

  // Load global CLAUDE.md as additional system context (shared across all groups)
  const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
  let globalClaudeMd: string | undefined;
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
  }

  // Combine global CLAUDE.md + Serena context for system prompt
  const systemPromptAppend = [globalClaudeMd, serenaContext].filter(Boolean).join('\n\n');
```

Then update the `systemPrompt` option in `query()`:

```typescript
      systemPrompt: systemPromptAppend
        ? { type: 'preset' as const, preset: 'claude_code' as const, append: systemPromptAppend }
        : undefined,
```

**Step 4: Add Serena to `mcpServers` and `allowedTools`**

In the `query()` options, update `mcpServers`:

```typescript
      mcpServers: {
        nanoclaw: {
          command: 'node',
          args: [mcpServerPath],
          env: {
            NANOCLAW_CHAT_JID: containerInput.chatJid,
            NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
            NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
          },
        },
        ...(serenaMcpUrl && {
          serena: {
            url: serenaMcpUrl,
            type: 'http' as const,
          },
        }),
      },
```

Update `allowedTools` to include Serena:

```typescript
      allowedTools: [
        'Bash',
        'Read', 'Write', 'Edit', 'Glob', 'Grep',
        'WebSearch', 'WebFetch',
        'Task', 'TaskOutput', 'TaskStop',
        'TeamCreate', 'TeamDelete', 'SendMessage',
        'TodoWrite', 'ToolSearch', 'Skill',
        'NotebookEdit',
        'mcp__nanoclaw__*',
        'mcp__serena__*',  // add this
      ],
```

**Step 5: Rebuild the container image**

```bash
cd ~/Work/nanoclaw && ./container/build.sh
```

Expected: Build completes successfully

**Step 6: Commit**

```bash
git add container/agent-runner/src/index.ts
git commit -m "feat(serena): add Serena MCP to container agent-runner with project context"
```

---

## Task 6: Configure `.env` and smoke test

**Files:**
- Modify: `.env` (not committed — secrets file)
- Modify: `.env.example`

**Step 1: Add Serena config to `.env.example`**

Append to `.env.example`:

```bash
# --- Serena HTTP Bridge (optional) ---
# URL to reach Serena MCP from inside containers
# SERENA_MCP_URL=http://host.docker.internal:8765/mcp

# Command to start Serena HTTP server (omit if running Serena externally/via VSCode)
# SERENA_START_CMD=uv run serena-mcp-server --transport streamable-http --host 127.0.0.1 --port 8765

# Projects available to agents: "name:/absolute/path,name2:/absolute/path2"
# SERENA_PROJECT_PATHS=nanoclaw:/home/user/Work/nanoclaw
```

**Step 2: Add to `.env`**

Edit `.env` to add (replace paths with your actual values):

```bash
SERENA_MCP_URL=http://host.docker.internal:8765/mcp
SERENA_START_CMD=uv run serena-mcp-server --transport streamable-http --host 127.0.0.1 --port 8765
SERENA_PROJECT_PATHS=nanoclaw:~/Work/nanoclaw
```

**Step 3: Build TypeScript**

```bash
cd ~/Work/nanoclaw && npm run build
```

Expected: Compiles without errors

**Step 4: Run full test suite**

```bash
cd ~/Work/nanoclaw && npx vitest run
```

Expected: All tests pass

**Step 5: Smoke test via WhatsApp**

Start NanoClaw (`npm run dev`) and send to the main WhatsApp group:

```
no projeto nanoclaw, mostre os símbolos exportados em src/config.ts
```

Expected response: Agent activates Serena project `nanoclaw`, calls `mcp__serena__get_symbols_overview`, returns list of exported symbols.

**Step 6: Commit**

```bash
git add .env.example
git commit -m "docs: add Serena HTTP bridge env example config"
```

---

## Troubleshooting Notes

**`host.docker.internal` not resolving inside container (Linux):**
The `--add-host=host.docker.internal:host-gateway` flag in Task 3 handles this. If it still fails, verify Docker version supports `host-gateway` (requires Docker 20.10+).

**Serena fails to start (`uv` not found):**
Ensure `uv` is on the system PATH. Install with: `curl -LsSf https://astral.sh/uv/install.sh | sh`

**Agent doesn't call `activate_project` first:**
Check the system prompt injection in Task 5. The `buildSerenaContext` function appends instructions to the system prompt — confirm `serenaContext` is non-empty in logs.

**Serena project not found:**
Verify `SERENA_PROJECT_PATHS` paths match the Serena project names configured in `.serena/project.yml` of each project. The name in `SERENA_PROJECT_PATHS` must match `project_name` in Serena config.
