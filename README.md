# Freight Auto-Reply

Auto-reply helper for **TIMOCOM** and **Trans.eu** chats.

- `extension/` — Firefox extension. Taps the logged-in tab's chat connection; keeps drafts, safety limits and the stop switch.
- `server/` — FastAPI web app. Each user edits a reply flow: **if** rule → my text or AI, **else if** …, **otherwise** → nothing, text or AI.

> **Before real use:** both platforms' terms require **written consent** for automation through third-party
> software or bots, including draft-only use as far as we can tell. See [docs/FRAMEWORKS.md](docs/FRAMEWORKS.md).
> Nothing has been tested on the real platforms: no real chat message has been captured yet.

Docs: [API](docs/API.md) · [platform protocols](docs/PLATFORMS.md) · [framework decision](docs/FRAMEWORKS.md)

## Reply flow
Rules are checked from the top; the first match wins. A rule matches on platform, "first message only"
and keywords (start of word, accents ignored) or every message. Action: your text, AI, or no reply.
Each rule is **Suggest** (default) or **Send automatically**. Auto-sent AI text gets an AI notice.
Keywords miss rephrasings: use *Otherwise → AI* to catch the rest.
The app does **not** know whether a freight is still open.

## Server configuration
| Variable | Default |
|---|---|
| `LLM_BASE_URL` | `https://litellm.osmosis.page/v1` |
| `LLM_API_KEY` | empty: AI branches return an error, text rules work |
| `LLM_MODEL` | `qwen3.6-27b` (open weights, Apache-2.0) |
| `LLM_TIMEOUT` | `75` seconds (the model host may need to wake) |
| `LLM_DAILY_LIMIT` | `200` AI calls per user per UTC day |
| `BASE_URL` | `http://localhost:8000` |
| `DATABASE_PATH` | `data/app.db` (`/data/app.db` in the image) |
| `PAYMENT_URL` | empty (online payment is not built) |

A model name starting `openrouter/` also sends OpenRouter's no-data-retention flags.

## Accounts (no public sign-up)
    docker compose exec freight python -m app.cli create-user someone@example.com   # prints a password
    # also: reset-password, activate, deactivate (deactivated accounts get HTTP 402)

## Install the extension (testing)
`about:debugging#/runtime/this-firefox` → **Load Temporary Add-on** → `extension/manifest.json`.
Then in its settings paste the access key from the website, **Test connection**, **Save**, reload the platform tabs,
and tick **Enabled** in the popup. Keep **Auto-send** off. A permanent install needs an AMO-signed build.

Not answered: TIMOCOM AI Negotiator chats, system notices, negotiation events, files, old or offline messages,
colleagues (TIMOCOM), and contacts you answered by hand in the last 60 minutes.

## Development
    cd server && uv sync && uv run pytest && uv run ruff check .
    uv run uvicorn app.main:create_app --factory --reload
    cd .. && npm install && npm test && npm run lint && npm run test:e2e

Never commit HAR captures: they contain live credentials and personal data.
