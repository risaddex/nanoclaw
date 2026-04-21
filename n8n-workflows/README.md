# NanoClaw → n8n Workflows

Workflows that connect NanoClaw's IPC system to n8n automations.

---

## nanoclaw-ipc-handler.json

Triggered whenever a command is posted to n8n via the IPC channel.

### How it works

```
NanoClaw agent (container)
  │  writes HTTP POST to n8n webhook
  ▼
n8n Webhook  →  Normalize Input  →  Route by Type
                                       │
                              ┌────────┼────────────┐
                              ▼        ▼             ▼
                       send_message  schedule_task  get_status
                              │        │             │
                              └────────┴─────────────┘
                                         │
                                   Respond OK (200)
```

### Import into n8n

1. Open your n8n instance.
2. Go to **Workflows → Import from file**.
3. Select `nanoclaw-ipc-handler.json`.
4. Activate the workflow.

The webhook URL will be something like:
```
https://<your-n8n>/webhook/nanoclaw-ipc
```

### Calling from a NanoClaw container agent

Inside an agent running in a NanoClaw container, call the n8n webhook via HTTP:

```bash
# Send a message via n8n → NanoClaw admin API
curl -s -X POST https://<your-n8n>/webhook/nanoclaw-ipc \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "send_message",
    "chatJid": "120363XXXXXXXX@g.us",
    "text": "Olá do n8n!"
  }'
```

Or from a container skill (TypeScript/Node):

```typescript
await fetch('https://<your-n8n>/webhook/nanoclaw-ipc', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'send_message',
    chatJid: env.CHAT_JID,
    text: 'Mensagem enviada via n8n',
  }),
});
```

### Supported command types

| `type`           | Required fields                          | What happens                              |
|------------------|------------------------------------------|-------------------------------------------|
| `send_message`   | `chatJid`, `text`                        | POSTs to NanoClaw admin API `/api/webhook` to deliver the message |
| `schedule_task`  | `chatJid`, `prompt`, `scheduleType`, `scheduleValue` | Sends an acknowledgment (see note below) |
| `get_status`     | —                                        | GETs `/api/config` from NanoClaw and returns it |
| *(anything else)*| —                                        | Returns `passthrough` acknowledgment      |

> **Note on `schedule_task`**: the current workflow acknowledges the command via the admin webhook.
> To fully schedule a task you must either:
> (a) write the IPC JSON file directly to `data/ipc/<group>/tasks/<uuid>.json` using an **Execute Command** node, or
> (b) call a new REST endpoint you add to `admin-server.ts`.
> The workflow node has an inline comment with the exact shell command to use.

### Prerequisites

- NanoClaw admin server running on `127.0.0.1:7324` (default).
- The target `chatJid` must be in the webhook allowlist:
  ```bash
  curl -X POST http://127.0.0.1:7324/api/webhook/allowlist/<jid>
  ```
- n8n reachable from wherever the agent runs (host network or a public URL).

### Extending the workflow

Add new branches to the **Route by Type** Switch node for any custom commands your agents need to trigger. Each branch can:
- Call external APIs (Slack, Notion, calendars, etc.)
- Write files or run shell commands
- Chain into other n8n workflows via HTTP Request
