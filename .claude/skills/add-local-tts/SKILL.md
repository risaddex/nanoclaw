---
name: add-local-tts
description: Add local text-to-speech — the inverse of /use-local-whisper. The agent can reply with a WhatsApp voice note using the macOS `say` command (or any configured TTS_COMMAND) plus ffmpeg re-encoding to OGG/Opus. Voice, language, and rate are configured via ENV vars. The agent only fires it when the user explicitly asks for an audio reply ("me responda por áudio", "resuma isso em um áudio").
---

# Local TTS (Text → WhatsApp Voice Note)

Pair with `/use-local-whisper`: one transcribes incoming voice notes; this one lets the agent reply with a voice note of its own. No paid TTS API, no container-side model — macOS `say` on the host does the synthesis, ffmpeg re-encodes to the OGG/Opus format WhatsApp expects for PTT (push-to-talk) messages.

## How it fires

- **The agent decides.** A single MCP tool `reply_with_audio(text)` is exposed inside the container. The agent calls it **only when the user explicitly asks** for audio — phrases like:
  - *"me responda por áudio ..."*
  - *"resuma isso em um áudio"*
  - *"responde em áudio"*
  - *"answer me with a voice note"*
- If the user did not explicitly ask, the agent replies with normal text. There is no keyword matching in the router; the tool description instructs the model directly.

## Pipeline

```
container agent → reply_with_audio(text)
      │
      ▼ IPC (data/ipc/{folder}/tasks/*.json)
host (src/tts.ts)
      │
      ▼ say -v <voice> -o raw.aiff "text"
      ▼ ffmpeg -c:a libopus -b:a 24k -ar 16000 -ac 1 out.ogg
      ▼ WhatsAppChannel.sendAudio(jid, oggBuffer)  → ptt:true
WhatsApp voice note
```

## Configuration (ENV)

| Variable       | Default       | Notes |
|----------------|---------------|-------|
| `TTS_COMMAND`  | `say`         | Host binary. Swap to `espeak-ng` / `pico2wave` / custom wrapper on Linux. Must accept `-v VOICE -o FILE TEXT` (or you fork the skill). |
| `TTS_VOICE`    | *(empty)*     | Override voice name (e.g. `Luciana`, `Samantha`). If empty, picks a default per `TTS_LANGUAGE`. |
| `TTS_LANGUAGE` | `pt_BR`       | Fallback language → voice lookup. Supported: `pt_BR`, `pt_PT`, `en_US`, `en_GB`, `es_ES`, `es_MX`, `fr_FR`, `de_DE`, `it_IT`, `ja_JP`. |
| `TTS_RATE`     | *(empty)*     | Words/minute, e.g. `180`. Empty = `say` default. |

List available voices on macOS: `say -v '?'`.

## File layout

```
.claude/skills/add-local-tts/
├── SKILL.md          # this file
└── agent.ts          # container-side MCP tool (compiled inside the container)
src/
└── tts.ts            # host-side IPC handler + say/ffmpeg pipeline
```

The host handler lives in `src/tts.ts` (not the skill dir) because the project's `tsconfig.json` has `rootDir: ./src` and won't compile files outside it. `agent.ts` is compiled inside the container and is copied at build time, so it can live in the skill dir.

## Installation

The host side is applied; the container side needs manual patches to the agent-runner and Dockerfile.

### Host side — already applied

- `src/tts.ts` — `handleTtsIpc(data, sourceGroup, isMain, dataDir, deps)` handler.
- `src/channels/whatsapp.ts` — new `sendAudio(jid, buffer)` method on `WhatsAppChannel`.
- `src/config.ts` — exports `TTS_COMMAND`, `TTS_VOICE`, `TTS_LANGUAGE`, `TTS_RATE`.
- `src/ipc.ts` — dispatches to `handleTtsIpc` in the task default case and `IpcDeps.sendAudio` is required.
- `src/index.ts` — wires `sendAudio` into `IpcDeps` by looking up the channel and calling its `sendAudio` method.
- `.env.example` — documents the four env vars.

### Container side — manual patches

**1. `container/agent-runner/src/ipc-mcp.ts`** — register the MCP tool.

Add at the top, after existing imports:

```ts
// @ts-ignore - copied from .claude/skills/add-local-tts/ during container build
import { createTtsTools } from './skills/add-local-tts/agent.js';
```

At the end of the tools array, just before the closing bracket:

```ts
    ...createTtsTools({ groupFolder, isMain }),
```

**2. `container/Dockerfile`** — copy the skill's agent.ts into the container image.

After the existing agent-runner COPY line and before `RUN npm run build`:

```dockerfile
# Copy TTS skill MCP tool
COPY .claude/skills/add-local-tts/agent.ts ./src/skills/add-local-tts/
```

**3. `container/build.sh`** — ensure the build context is the project root (so the `COPY` above can reach `.claude/...`). If not already done (by `x-integration` or similar), change:

```bash
docker build -t "${IMAGE_NAME}:${TAG}" .
```

to:

```bash
cd "$SCRIPT_DIR/.."
docker build -t "${IMAGE_NAME}:${TAG}" -f container/Dockerfile .
```

### Required CLI tools on the host

```bash
which say     # macOS built-in
which ffmpeg  # brew install ffmpeg
```

On Linux, install `ffmpeg` + an alternative TTS binary (e.g. `espeak-ng`), then set `TTS_COMMAND=espeak-ng` and pick a voice. Note: only `say` is directly spec'd; other binaries may need minor argument tweaks in `src/tts.ts`.

### Build & restart

```bash
./container/build.sh
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw  # macOS
# Linux: systemctl --user restart nanoclaw
```

## Usage

From your registered WhatsApp chat:

```
@Andy resuma isso em um áudio        ← replying to a long message
@Andy me responda por áudio: qual o clima amanhã?
@Andy responde em áudio com um resumo das últimas 3 tarefas
```

The agent will reply as a WhatsApp voice note.

**If you don't ask for audio, it replies as text.** That's the point of putting the decision inside the model via the MCP tool rather than a router rule.

## Verification

1. `npm run build` — compiles clean.
2. `npx vitest run src/channels/whatsapp.test.ts src/ipc-auth.test.ts` — existing tests pass.
3. Manual synth test on the host (no container needed):
   ```bash
   node -e "import('./dist/tts.js').then(async m => {
     const h = {
       sendAudio: async (jid, buf) => { require('fs').writeFileSync('/tmp/tts.ogg', buf); console.log('wrote', buf.length, 'bytes'); },
       registeredGroups: () => ({ 'test@g.us': { jid: 'test@g.us', folder: 'test' } }),
     };
     await m.handleTtsIpc({ type: 'tts_reply', requestId: 'r1', text: 'Olá! Isto é um teste.' }, 'test', false, process.cwd() + '/data', h);
     console.log('result:', require('fs').readFileSync('data/ipc/test/tts_results/r1.json', 'utf-8'));
   })"
   # Then play it:
   open /tmp/tts.ogg
   ```
4. Live test: send *"@Andy me responda por áudio: diga olá em português brasileiro"* to a registered chat. Expect a WhatsApp voice note within a few seconds.

## Security / scope notes

- `say` and `ffmpeg` run as subprocesses on the host. Text goes directly to `say`'s positional argument (not through a shell) — no shell-injection risk.
- No credentials involved. No network calls (unlike OpenAI/ElevenLabs TTS).
- Works in any registered group. If you want to lock this to the main group only, add `if (!isMain) return { ... }` inside `agent.ts` mirroring the pattern in `x-integration`.
- Current scope: WhatsApp only. Telegram/Slack voice note support would need `sendAudio` on those channels plus format tweaks (Telegram uses OGG/Opus too; Slack uploads files differently).
