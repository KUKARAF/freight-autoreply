# Extension ↔ web app API

`Authorization: Bearer <access key>` (created on the website, one per account, stored hashed).
Client: `extension/lib/backend.js`. Server: `server/app/main.py`.

## `GET /v1/me`
`200 {"email": "...", "aiConfigured": true}`

## `POST /v1/decide`
```json
{
  "platform": "timocom",
  "text": "incoming message",
  "senderName": "", "senderFirstName": "",
  "isFirst": true,
  "history": [{"role": "them", "text": "..."}],
  "context": {"loadingCity": "", "unloadingCity": "", "senderCompany": ""}
}
```
`200`:
```json
{"action": "reply", "text": "...", "autoSend": false, "source": "rule: Is it still available?", "note": ""}
```
`action` is `reply`, `ignore` or `none`. `autoSend` is only permission from the rule: the extension sends
without review only if its own **Auto-send** switch is on and its limits allow it.

| status | meaning |
|---|---|
| 401 | bad access key |
| 402 | account not active: `{"paymentUrl": "..."}` |
| 422 | invalid request |
| 429 | more than 60 requests a minute |
| 503 | AI branch failed: not configured, daily cap, or provider error |

The server stores no message text. LiteLLM or the model server may log it: check their settings.
