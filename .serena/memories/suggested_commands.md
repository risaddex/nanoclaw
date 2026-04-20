---
name: Suggested commands
description: Build, test, format, lint commands for NanoClaw
type: project
---

## Build & Run
- `npm run build` — compile TypeScript (src/ → dist/)
- `npm run dev` — run with hot reload (tsx)
- `./container/build.sh` — rebuild Docker agent container (required after container/agent-runner/src/ changes)

## Test & Quality
- `npm test` — run all tests (vitest)
- `npm run typecheck` — type-check without emitting
- `npm run lint` — eslint src/
- `npm run lint:fix` — auto-fix lint issues
- `npm run format` — prettier format src/

## Service (macOS launchd)
- `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` — restart service
- `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` — stop
- `launchctl load ~/Library/LaunchAgents/com.nanoclaw.plist` — start

## After any task
1. `npm run build` — verify TypeScript compiles
2. If container/agent-runner/src/ changed: `./container/build.sh`
3. `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` — restart service
