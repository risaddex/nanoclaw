# Design: Serena HTTP Bridge for WhatsApp-to-Agent Workflow

**Date:** 2026-03-07
**Status:** Approved

## Goal

Enable delegation of coding tasks via WhatsApp to Claude agents running in NanoClaw containers,
with access to the Serena MCP (language server, symbol navigation, shared memories) and project
filesystems on the host.

## Workflow

```
1. User sends WhatsApp message: "no projeto nanoclaw, resolve: [issue]"
2. NanoClaw spawns container with project mounts + Serena MCP URL
3. Agent calls mcp__serena__activate_project("nanoclaw")
4. Agent uses Serena tools to read/edit code (find_symbol, replace_symbol_body, etc.)
5. Agent uses Bash for builds/tests in /workspace/extra/{project}/
6. Agent returns result → WhatsApp
```

## Architecture

```
WhatsApp → NanoClaw (host) ──────────────────────────────────────────────────
                             │                                               │
                             │  spawns container                            │
                             ▼                                               ▼
                    [Docker Container]                          [Serena HTTP :8765]
                    Claude Code SDK                             (standalone process)
                         │                                           │
                         ├── mcp__nanoclaw__* (IPC)                 │
                         └── mcp__serena__*  ─── HTTP ──────────────┘
                              find_symbol,                  accesses host filesystem
                              replace_symbol_body,          with TypeScript LSP
                              write_memory, etc.
```

**Key insight:** Serena runs on the HOST and accesses files directly — the container does not
need project mounts for code reading/editing via Serena. Project mounts are only needed for
`Bash` operations (running tests, builds).

## Components

### 1. Serena HTTP Server (`src/serena-bridge.ts`)

- Starts Serena as a child process: `uv run serena-mcp-server --transport streamable-http --port 8765`
- Binds to `127.0.0.1:8765` (localhost only)
- NanoClaw manages lifecycle: starts on startup, restarts on crash
- Called from `src/index.ts` if `SERENA_MCP_URL` is configured

### 2. Container networking

- Linux: adds `--add-host=host.docker.internal:host-gateway` to container args
- Container connects to `http://host.docker.internal:8765/mcp`

### 3. Project mounts

- `SERENA_PROJECT_PATHS=name:/path,name:/path` in `.env`
- All configured projects are mounted read-only at `/workspace/extra/{name}/`
- Agent uses Bash in `/workspace/extra/{name}/` for tests/builds
- Agent calls `mcp__serena__activate_project("{name}")` to switch Serena context

### 4. Agent system prompt injection

Container receives list of available projects. System prompt includes:
- Available project names and their container paths
- Instruction to call `activate_project` before using Serena tools
- Reminder that Bash builds should use `/workspace/extra/{project}/`

## Configuration (`.env`)

```env
# Serena HTTP MCP bridge
SERENA_MCP_URL=http://host.docker.internal:8765/mcp

# Projects available to agents (name:host-path pairs, comma-separated)
SERENA_PROJECT_PATHS=nanoclaw:/home/user/Work/nanoclaw,myapp:/home/user/Work/myapp
```

## Serena Tools Exposed to Agent

| Tool | Purpose |
|------|---------|
| `activate_project` | Switch Serena to requested project |
| `find_symbol` | Navigate code by symbol name |
| `get_symbols_overview` | Understand file structure |
| `search_for_pattern` | Grep-like search with context |
| `read_file` | Read files via Serena |
| `replace_symbol_body` | Edit a symbol definition |
| `create_text_file` | Create/overwrite a file |
| `write_memory` | Persist notes to Serena memory |
| `read_memory` | Retrieve Serena memories |
| `list_memories` | List available memories |

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/serena-bridge.ts` | NEW: Serena HTTP process lifecycle manager |
| `src/config.ts` | Add `SERENA_MCP_URL`, `SERENA_PROJECT_PATHS` |
| `src/container-runner.ts` | Add `--add-host`, project mounts, pass Serena URL |
| `src/index.ts` | Call `startSerenaServer()` on startup |
| `container/agent-runner/src/index.ts` | Add Serena MCP to `mcpServers`, update `allowedTools`, inject project context in system prompt |

## Security Notes

- Serena binds to `127.0.0.1` only — not accessible from outside the host
- Container accesses Serena via `host.docker.internal` (Docker-managed route)
- Project mounts use read-only (`ro`) flag — agent cannot modify files via Bash mount
  (writes go through Serena tools which respect Serena's own permission model)
- `SERENA_PROJECT_PATHS` is defined on the host only — containers cannot influence mount config
