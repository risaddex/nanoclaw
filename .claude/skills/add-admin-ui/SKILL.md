---
name: add-admin-ui
description: Add a local-only (127.0.0.1) read-only admin UI that lists the groups, chats, registered channels, and NanoClaw configuration. Useful for quickly inspecting what the WhatsApp/Baileys channel sees without querying the SQLite database manually or re-running setup.
---

# Admin UI

A tiny localhost-only web console to inspect NanoClaw state at runtime: Baileys groups, registered chats, DB chat metadata, and config.

> **Read-only, loopback-only.** Binds to `127.0.0.1` exclusively. Any request from a non-loopback address is rejected with 403. No write actions in this iteration.

## What you get

Open `http://127.0.0.1:<ADMIN_PORT>/` (default `7324`) and you'll see:

- **Groups** — every WhatsApp group the bot is a participant in (live from `groupFetchAllParticipating()`).
- **Group detail** — click a group to see its full metadata including participants.
- **Chats** — all chats known to the SQLite DB, ordered by most recent activity.
- **Registered** — the `registered_groups` table (which chats the router actively serves).
- **Channels** — every installed channel and its connection status.
- **Config** — non-secret runtime values (assistant name, trigger, timezone, paths).

Secrets are **never** exposed — no env dump, no credentials.

## JSON API

The UI is a thin client over a JSON API served from the same process. You can `curl` it directly:

```bash
curl -s http://127.0.0.1:7324/api/channels   | jq
curl -s http://127.0.0.1:7324/api/groups     | jq
curl -s "http://127.0.0.1:7324/api/groups/<jid>@g.us" | jq
curl -s http://127.0.0.1:7324/api/chats      | jq '.[0:5]'
curl -s http://127.0.0.1:7324/api/registered | jq 'keys'
curl -s http://127.0.0.1:7324/api/config     | jq
```

## Installation

This skill ships three moving parts:

1. **`src/admin-server.ts`** — HTTP glue + JSON API (lives in core because it imports `WhatsAppChannel`, `db`, `config` — the TypeScript project root only covers `src/`).
2. **`.claude/skills/add-admin-ui/ui/`** — the static visualization (HTML/CSS/JS) served by the admin server.
3. Integration edits in `src/config.ts`, `src/channels/whatsapp.ts`, `src/index.ts`, `.env.example`.

### Changes needed

**1. `src/config.ts`** — add:

```ts
export const ADMIN_PORT = Math.max(
  1,
  parseInt(process.env.ADMIN_PORT || '7324', 10) || 7324,
);
```

**2. `src/channels/whatsapp.ts`** — add two public methods on `WhatsAppChannel` (right above `syncGroupMetadata`):

```ts
async listGroups(): Promise<Record<string, GroupMetadata>> {
  if (!this.connected) throw new Error('WhatsApp channel not connected');
  return this.sock.groupFetchAllParticipating();
}

async getGroupMetadata(jid: string): Promise<GroupMetadata | undefined> {
  if (!this.connected) throw new Error('WhatsApp channel not connected');
  return this.getNormalizedGroupMetadata(jid, true);
}
```

**3. `src/index.ts`** — import, declare, start, shutdown:

```ts
import type { Server as HttpServer } from 'http';
// ...
import { startAdminServer } from './admin-server.js';
```

Declare the handle before the shutdown closure so the closure can see it:

```ts
let adminServer: HttpServer | undefined;
```

Close the server first in the shutdown path:

```ts
const shutdown = async (signal: string) => {
  logger.info({ signal }, 'Shutdown signal received');
  if (adminServer) {
    await new Promise<void>((resolve) => adminServer!.close(() => resolve()));
  }
  await queue.shutdown(10000);
  for (const ch of channels) await ch.disconnect();
  process.exit(0);
};
```

Start the server after the channel-connect loop:

```ts
adminServer = startAdminServer(channels);
```

**4. `.env.example`** — document the knob:

```
ADMIN_PORT=7324
```

### Build & run

```bash
npm run build
npm run dev   # or restart the service
```

Then open `http://127.0.0.1:7324/`.

## File layout

```
.claude/skills/add-admin-ui/
├── SKILL.md              # this file
└── ui/
    ├── index.html        # entry point
    ├── app.js            # fetches /api/* and renders
    └── styles.css        # styles
src/
└── admin-server.ts       # HTTP + JSON API + static file serving
```

## Security model

- **Bind**: `127.0.0.1` only. External interfaces cannot reach the port.
- **Origin check**: the server double-checks `req.socket.remoteAddress` against a loopback allowlist before serving any route, so even a misconfigured reverse proxy can't accidentally expose it.
- **Read-only**: only `GET` is accepted; any other verb returns 405.
- **No auth**: loopback is the trust boundary. Anyone with a shell on the host can already read `store/auth/creds.json` and the SQLite DB.

## Non-goals (for now)

- No write/action endpoints (join group, send message, kick member). Deferred until the read surface is battle-tested.
- No non-WhatsApp channel introspection beyond `/api/channels` status. Telegram/Slack/etc. currently don't ship comparable enumeration APIs; adding them later is trivial.
- No CSRF token or auth — loopback-only is the entire story. If you ever plan to expose this beyond localhost, revisit.

## Verification

1. `npm run build` — must compile clean.
2. `npx vitest run src/channels/whatsapp.test.ts` — all WhatsApp tests still pass.
3. Start the service. Confirm the log line `admin UI listening on 127.0.0.1`.
4. `curl -s http://127.0.0.1:7324/api/groups | jq 'length'` → matches the group count visible in the WhatsApp app.
5. Open `http://127.0.0.1:7324/` in a browser — groups, chats, and config are visible.
6. `curl -s http://<your-lan-ip>:7324/api/groups` → must fail to connect (proves loopback-only).
