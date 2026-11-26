# Decision: web app, framework and chat-flow setup

> **What was built (2026-11-26)** differs from the recommendation below, by choice: FastAPI + SQLite with
> server-rendered pages, an editable if / else-if / otherwise rule list where the AI is one action, and
> `qwen3.6-27b` through a self-hosted LiteLLM. AI intent classification, scenario cards, offer-status lookup,
> payments and maps are not built.

Researched 2026-11-26 by four research agents. **Checked directly by the lead:** the TIMOCOM automation clauses,
TIMOCOM's assistant announcement and the Dify licence. Everything else comes from agent reports and should be
re-checked at the linked source before anything depends on it. Not legal advice.

## 0. Blockers to settle with the client first
- **TIMOCOM** [GTC](https://www.timocom.co.uk/gtc) (status 01.01.2026): automation by "third-party software, bots, scripts or
  other aids which deviate from the standard of commercially available browsers ... requires the written consent of TIMOCOM".
  The Messenger terms also exclude unauthorised automated access, and building a functionally similar product with the service.
- **Trans.eu** [Regulamin](https://www.trans.eu/wp-content/uploads/2026/04/Regulamin-PLATFORMY-TRANS.EU-01.05.2026.pdf) VI.2.7
  (01.05.2026): similar written-consent rule for bots, scripts and third-party software. A breach appears to fall in the
  penalty tier of twice the annual net subscription.
- Draft-only mode may lower the risk. It does not clearly remove it. `har/old/timocom.js` (auto-republish) raises the same issue.
- Neither public API catalogue showed chat endpoints
  ([TIMOCOM](https://developer.timocom.com/), [Trans.eu](https://www.trans.eu/api/general-information/about-api/)).
- **Native competition:** TIMOCOM
  [announced an AI negotiation assistant](https://www.timocom.de/unternehmen/newsroom/iaa-2026-timocom-stellt-ai-verhandlungsassistent-vor)
  (22.10.2026) that answers recurring questions on price, availability and loading. No price or release date given.
  Trans.eu has a negotiation assistant for carriers (decision support; no chat auto-reply found).
- **EU AI Act** [Art. 50](https://artificialintelligenceact.eu/article/50/): applies since 2026-08-02. People must be told they are
  talking to AI. The extension does not add this yet. Also plan GDPR (processor agreements, transfers, retention).

## 1. Build or adopt
Build our own small web app. Do not give customers a flow editor.

| Tool | Why not as the customer UI |
|---|---|
| n8n | not open source (Sustainable Use License); customers may not configure it |
| Dify | modified Apache: multi-tenant needs written permission, logo must stay |
| Typebot | FSL-1.1, not open source |
| Flowise | repository archived August 2026 |
| Langflow | MIT, but no tenant isolation; hard for non-technical users |
| Activepieces | MIT core; embedding is Enterprise |
| Node-RED, Windmill, Sim | developer tools or paid multi-tenant features |
| Chatwoot, Botpress, Rasa | inbox, cloud studio or maintenance mode |

Not fully assessed: Tiledesk (server source repository returned 404). Node-RED is an optional developer back office.

## 2. What the customer sees
1. **Payment.**
2. **About your company:** a short text box for facts and tone. This is the "prompt".
3. **Scenario cards** ("Is it still available?", "What is the price?", "Loading times?"): approved reply per language and
   **Off / Suggest / Auto-send** (default Suggest).
4. **Try it:** paste a message, see the reply and why.
5. History and a stop button.

No rule builder, no decision graph. Prompt-only is rejected: it cannot guarantee a factual answer, and non-experts
tend to test prompts unsystematically ([small study](https://people.eecs.berkeley.edu/~bjoern/papers/zamfirescu-johnny-chi2023.pdf)).

## 3. Reply pipeline
1. **Code guards:** limits, opt-out, duplicates, human took over, platform bot active.
2. **LLM classifies only:** `{intent, language, entities, needs_human}` with `unknown` allowed (strict schema, validated).
3. **Code decides:** looks up facts, picks the approved template. Unknown intent or fact: draft or hand to a human.
4. **Free-text LLM replies:** always drafts.

**"Yes, it is available" needs live offer status**, not a toggle. Candidates seen in the captures, response fields not yet
examined: TIMOCOM `/app/tccargo/api/freight-editor-offers` (chat carries the offer id in `tc_context_id`),
Trans.eu `/app/freights/api/rest/v3/freights`. Unknown or no match: never auto-send.

## 4. Stack
| Part | Pick | Licence |
|---|---|---|
| Web app | Next.js, TypeScript | MIT |
| Data, jobs | Postgres, Drizzle, pg-boss | PostgreSQL, Apache-2.0, MIT |
| Login, organisations, API keys | [Better Auth](https://github.com/better-auth/better-auth) (set it to read the Bearer header) | MIT |
| LLM | [Vercel AI SDK](https://github.com/vercel/ai) + OpenRouter provider | Apache-2.0 |
| Tests of classification | [promptfoo](https://github.com/promptfoo/promptfoo) | MIT |
| Payments | Stripe Checkout + customer portal (Polar if tax should be handled for you) | Stripe is proprietary |
| Spend caps | one OpenRouter key per tenant with a limit; own usage ledger | |
| Later, only if needed | [ZEN engine](https://github.com/gorules/zen), react-querybuilder, Langfuse (`ee/` excluded) | MIT |

- Return 402 to the extension only for the tenant's own payment or quota, never for our OpenRouter balance.
- For chat data, require OpenRouter `zdr: true` and `data_collection: "deny"`.
- "Open source" can only cover our code and libraries: Stripe, OpenRouter, hosted models and commercial maps are services.
  AGPL-3.0 if hosted changes must stay open, Apache-2.0 otherwise.

## 5. Maps
- Google truck routing: [continental US and Japan (experimental) only](https://developers.google.com/maps/documentation/routes/lvr),
  limited access. No Poland or Germany.
- Google's agent route tool has [no truck mode](https://developers.google.com/maps/ai/maps-experience-agent-tools/compute-routes).
- [EEA terms](https://cloud.google.com/terms/maps-platform/eea/maps-service-terms) give agent tools a limited LLM exception with
  attribution and no modification. Using ordinary Routes/Geocoding output with an LLM looks high-risk.
- Do: provider-neutral tools (geocode, truck route, matrix, tolls), with deadhead/detour computed in code.
- Prototype: self-hosted [Valhalla](https://github.com/valhalla/valhalla) + [Photon](https://github.com/komoot/photon), no toll prices.
  OSM truck-restriction quality in PL/DE is unverified.
- Production: evaluate [PTV](https://developer.myptv.com/en/documentation/routing-api) (truck routing, tolls), then TomTom.
  Price and LLM terms unverified. HERE's terms bar AI use without permission.
- The availability question needs no maps, so maps is not required for the first version.

## 6. Changes needed in the existing extension
- `docs/LLM_BACKEND.md`: today the backend returns free text. Move to intent, scenario and template, with a `mayAutoSend` flag.
- Send offer id (and later route data) to the backend, which the contract currently excludes.
- Move rules and scenarios to the server; the extension keeps safety limits, drafts and the stop switch.
- Add AI disclosure.
- Add the offer-status lookup.

## 7. Order of work
0. Client asks TIMOCOM and Trans.eu for written consent; decide positioning against TIMOCOM's assistant.
1. Capture real chat messages and offer-status responses.
2. Web app: login, one "availability" card, test box, classification evals in PL/DE/EN. Suggest mode only.
3. Payment and spend caps.
4. More cards. Auto-send only if consent and accuracy allow.
5. Maps.
