---
name: NanoClaw project overview
description: Purpose, tech stack, architecture
type: project
---

NanoClaw is a personal Claude assistant. Single Node.js process (TypeScript, ESM) that bridges
messaging channels (WhatsApp, Telegram, Slack, Discord) to the Claude Agent SDK running in Docker containers.

**Tech stack:**
- Host: Node.js 22, TypeScript (ES2022/NodeNext), better-sqlite3, @whiskeysockets/baileys, @onecli-sh/sdk
- Container agent-runner: @anthropic-ai/claude-agent-sdk, @modelcontextprotocol/sdk
- Build: tsc → dist/; container rebuilt with ./container/build.sh
- Test: vitest; Format: prettier (singleQuote:true); Lint: eslint

**Key source directories:**
- src/ — host orchestrator (channels, container-runner, IPC, DB, config)
- container/agent-runner/src/ — runs INSIDE Docker (index.ts, ipc-mcp-stdio.ts, ollama-mcp-stdio.ts)
- setup/ — guided setup steps (run via npx tsx setup/index.ts --step <name>)
- data/ipc/<group>/ — per-group IPC files, mounted at /workspace/ipc inside containers
- data/sessions/<group>/ — per-group .claude/ and agent-runner-src/ mounts

**OneCLI:** credential proxy (never exposes secrets to containers). Injects API keys/tokens into
outbound HTTPS traffic at proxy time. Sets HTTPS_PROXY + NODE_EXTRA_CA_CERTS in container env.

**Container agent-runner env vars available:** process.env includes proxy vars from OneCLI, TZ, etc.
sdkEnv spreads process.env for the SDK query call.
