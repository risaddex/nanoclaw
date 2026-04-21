---
name: add-admin-ui
description: Add a local-only (127.0.0.1) admin UI + JSON API to inspect groups, chats, registered channels, and NanoClaw configuration — and a webhook endpoint that external/local callers can POST to in order to deliver a message to an allowlisted JID. Supports reusable message templates referenced by template_id.
---

# Admin UI

A tiny localhost-only web console to inspect NanoClaw state at runtime and to fire webhook deliveries at allowlisted chats.

> **Loopback-only.** Binds to `127.0.0.1` exclusively. Any request from a non-loopback address is rejected with 403. Inspection routes are `GET`-only; webhook routes accept `POST`/`PUT`/`DELETE` but only for loopback.

## What you get

Open `http://127.0.0.1:<ADMIN_PORT>/` (default `7324`):

- **Groups** — every WhatsApp group the bot is a participant in (live from `groupFetchAllParticipating()`).
- **Group detail** — click a group to see its full metadata including participants.
- **Chats** — all chats known to the SQLite DB, ordered by most recent activity.
- **Registered** — the `registered_groups` table (which chats the router actively serves).
- **Channels** — every installed channel and its connection status.
- **Config** — non-secret runtime values (assistant name, trigger, timezone, paths).
- **Webhooks** — manage the send-allowlist, CRUD message templates (`{{variable}}` placeholders), and test deliveries.

Secrets are **never** exposed — no env dump, no credentials.

## JSON API

The UI is a thin client over a JSON API served from the same process. You can `curl` it directly:

```bash
# Inspection (read-only)
curl -s http://127.0.0.1:7324/api/channels   | jq
curl -s http://127.0.0.1:7324/api/groups     | jq
curl -s "http://127.0.0.1:7324/api/groups/<jid>@g.us" | jq
curl -s http://127.0.0.1:7324/api/chats      | jq '.[0:5]'
curl -s http://127.0.0.1:7324/api/registered | jq 'keys'
curl -s http://127.0.0.1:7324/api/config     | jq

# Webhook
curl -s http://127.0.0.1:7324/api/webhook              | jq  # full config
curl -s -X POST http://127.0.0.1:7324/api/webhook \
  -H 'content-type: application/json' \
  -d '{"jid":"5511...@s.whatsapp.net","message":"Build finished"}'
curl -s -X POST http://127.0.0.1:7324/api/webhook \
  -H 'content-type: application/json' \
  -d '{"jid":"5511...@s.whatsapp.net","template_id":"deploy","variables":{"env":"prod","version":"v1.2.3"}}'
```

### Webhook — endpoint reference

`POST /api/webhook` — deliver a message. Body is **either** `{ jid, message }` **or** `{ jid, template_id, variables? }`. Enforces that `jid` is on the allowlist. Returns `{ ok, jid, channel, bytes }` on success; `{ error, detail }` with an appropriate status otherwise (`400 missing_jid`, `403 jid_not_in_allowlist`, `404 template_not_found`, `503 channel_not_connected`).

Allowlist:
- `GET    /api/webhook/allowlist` → `string[]`
- `PUT    /api/webhook/allowlist` body `{ jids: string[] }` → replaces the full list
- `POST   /api/webhook/allowlist/<urlencoded-jid>` → adds one JID
- `DELETE /api/webhook/allowlist/<urlencoded-jid>` → removes one JID

Templates:
- `GET    /api/webhook/templates` → `Record<id, { id, template, description? }>`
- `PUT    /api/webhook/templates/<id>` body `{ template, description? }` → upserts
- `DELETE /api/webhook/templates/<id>` → removes

Template placeholders use Mustache-lite: `{{name}}` → `variables.name` at send time. Missing variables render as empty string (no error). Only `[a-zA-Z0-9_.-]` characters in names.

### Storage

The webhook allowlist + templates are persisted to `store/webhook.json` — a single JSON file rewritten atomically on every mutation. Safe to hand-edit while the service is stopped.

### Security notes on webhook

- Loopback-only bind is the trust boundary. If you want external services to hit the webhook, put a reverse proxy / cloudflared / SSH tunnel in front and add your own auth layer — don't rebind the socket to 0.0.0.0 without one.
- The allowlist is the second line of defense: even if localhost is compromised, the webhook can only deliver to JIDs you explicitly added via the UI.
- The webhook uses the channel's own `sendMessage` path, so messages go through existing formatting/retry logic. On a shared WhatsApp number the bot name is still prepended.

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
