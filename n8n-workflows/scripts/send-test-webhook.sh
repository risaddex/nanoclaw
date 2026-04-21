N8N_HOST=n8n.daniloromano.dev

curl -s -X POST https://$N8N_HOST/webhook-test/nanoclaw-ipc \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "send_message",
    "chatJid": "120363425345307575@g.us",
    "text": "Olá do n8n!"
  }'