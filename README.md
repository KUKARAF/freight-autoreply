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
| `LLM_MODEL` | `privacy-qwen3.6-35b-a3b` (open weights, Apache-2.0; LiteLLM → OpenRouter privacy workspace, zero data retention) |
| `LLM_TIMEOUT` | `75` seconds |
| `LLM_DAILY_LIMIT` | `200` AI calls per user per UTC day |
| `BASE_URL` | `http://localhost:8000` |
| `DATABASE_PATH` | `data/app.db` (`/data/app.db` in the image) |
| `PAYMENT_URL` | empty (online payment is not built) |

`privacy-*` models get their no-retention flags from the LiteLLM config; `openrouter/*` names send them from the app.

## Sign-in: single sign-on only
There are no passwords in this app. Sign-in is OpenID Connect (authorization code + PKCE, **public client, no secret**).
An account is created on first sign-in, only for members of an allowed group.

| Variable | Default |
|---|---|
| `OIDC_ISSUER` | `https://auth.osmosis.page/application/o/freight/` |
| `OIDC_CLIENT_ID` | empty: sign-in is disabled |
| `OIDC_ALLOWED_GROUPS` | `freight,authentik Admins` (empty: nobody gets in) |

Authentik: OAuth2/OpenID provider, client type **Public**, a **signing key** selected (RS256), redirect URI
`https://freight.osmosis.page/auth/callback` (strict), scopes `openid email profile`; application slug `freight`.

Sessions last 12 hours. **Removing someone in Authentik does not revoke their extension access key**:
also run `docker compose exec freight python -m app.cli deactivate EMAIL` (`list`, `activate` also exist).

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
