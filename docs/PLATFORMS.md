# Platform protocol notes

Sources:
- **HAR**: captures in `har/` (gitignored, they contain live credentials; never commit them).
- **JS**: public static bundles, fetched anonymously. The HARs list them with empty bodies, or not at all (304).
  - `https://cdn.platform.trans.eu/modules/@trans.eu/messenger-client/14.65.2/` (`xmpp.service.js`,
    `messenger.service.js`, `messenger.module.js`, `ext/@trans.eu/stanza-service/15.8.0`,
    `ext/@trans.eu/stanza-plugins/12.4.0`, `ext/@trans.eu/stanza/1.3.0`)
  - `https://my.timocom.com/app/hiway/widget/mf-manifest.json` and `static/HiwayMFBridge-*.js`

**Not observed:** no HAR contains a WebSocket frame (Firefox HAR export drops them), and every
TIMOCOM channel query returned `channels: []`. So there is **no real sample of a chat message**.
Message shapes below come from the client code, and for TIMOCOM also from the GetStream SDK it bundles.

---

## TIMOCOM (`my.timocom.com`)

### Auth
1. Keycloak, realm `timocom`, client `web-ui-public-login`, authorization code + PKCE:
   `GET iam.timocom.com/realms/timocom/protocol/openid-connect/auth`, then `POST .../token`.
   SSO cookies on `iam.timocom.com` (`KEYCLOAK_IDENTITY`, ...) make this silent when logged in.
2. Access token: RS256, **600 s**. Refresh token: **7200 s**.
3. `my.timocom.com` APIs take `Authorization: Bearer <access token>`. The cookies seen there are
   load-balancer cookies (plus `JSESSIONID` on the HTML page).
4. Chat ("Messenger", internal name *Hiway*): `GET /app/hiway/api/auth/token` (Bearer) returns
   `{token}`, a **GetStream** JWT (HS256, `user_id`, about 1 h). `GET /app/hiway/api/auth/user`
   returns `{userId}`.

### Receiving
- `wss://chat.stream-io-api.com/connect?json=...&api_key=...&authorization=<stream jwt>&stream-auth-type=jwt`
- First frame (SDK behaviour): `health.check` with `connection_id` and `me`.
- Events (JSON): `message.new` (watched channels), `notification.message_new` (other member channels, includes `channel`).
- Channel list: `POST chat.stream-io-api.com/channels?user_id&connection_id&api_key` with `filter_conditions`.
- Channel types seen in queries: `messaging`, `notification` (system notices, never answer these).
- Channel custom fields: `tc_context_type` (`TC_CARGO__CARGO`, `TC_CARGO__LOADING_SPACE`),
  `tc_context_id` (offer id), `tc_context_loadingPlaces_cities` / `_countryCodes`,
  `tc_context_startAddress_city`, `tc_context_destinationAddresses_cities`,
  `tc_context_useAiNegotiator`, `tc_context_aiNegotiatorEnabledAtCreation`, `tc_context_negotiationStatus`.
- User fields: `tc_profile_firstName`, `_lastName`, `_companyName`, `_globalCompanyId`.
- System messages carry `tc_systemMessage_*`.

### Sending
`POST https://chat.stream-io-api.com/channels/{type}/{id}/message?api_key=..&user_id=..`
headers `Authorization: <stream jwt>`, `stream-auth-type: jwt`, body `{"message":{"id":"<uuid>","text":"..."}}`.

### TIMOCOM backend (`/app/hiway/api`)
`/channel/open`, `/channel/delete`, `/channel/{id}/priceProposal/{accept,withdraw}`,
`/channel/{id}/{enable,disable}AiNegotiator`, `/deal/add`, `/channel/{id}/export`.

**TIMOCOM has its own AI Negotiator.** The extension skips channels where it is on.

### Price proposals (not chat, not automated)
`GET /app/tccargo/api/received-priceproposals/{publicOfferId}?sortDirection=DESC&indexField=PRICE`,
`POST /priceproposals`, `PUT /priceproposals/{id}` (withdraw), `PUT /accepted-priceproposals/{id}` (accept).
Only empty results were captured.

---

## Trans.eu (`platform.trans.eu`)

### Auth
- OAuth Bearer JWT, issuer `https://auth.platform.trans.eu/`, audience `trans-login`. In the capture, `exp - iat` = 6 h.
- Refresh endpoint from frame config: `https://auth.platform.trans.eu/accounts/token`
  (CSRF: `api-platform.trans.eu/app/trans/default/login?get_csrf_token`). No refresh call was captured.
- REST calls also send `X-Session-Id` and `x-app-version`.
- One direct REST call got a **Cloudflare challenge** (403), so requests made outside the page may be blocked.

### Chat transport: XMPP over WebSocket (ejabberd, stanza.js)
- `wss://xmpp-ejabberd.platform.trans.eu/websocket`, subprotocol `xmpp`, one stanza per frame.
- JID `{trans_id}@trans.eu` (`trans_id` looks like `1234567-1`), resource `t6-<uuid>`.
- SASL: every mechanism except **PLAIN** is disabled. Password = access token.
- Stream management (XEP-0198) **on**, `useContextV2` **on** (frame config in HAR). Carbons enabled.
- History: MAM at `archive.trans.eu`.

### Receiving
`<message from="peer@trans.eu/res" to="me@trans.eu" type="normal|chat" id="..">` with:

| child | namespace | meaning |
|---|---|---|
| `body` | | text |
| `stanza-id id by` | `urn:xmpp:sid:0` | server id |
| `meta/item name value` | `http://trans.eu/xmpp/message_metadata` | `from_account_id`, `to_account_id` |
| `request` | `http://trans.eu/xmpp/message_status` | receipt wanted |
| `context id` + `owner id`, `context-item id` | `urn:trans.eu:xmpp:context` | freight context (v1) |
| `context` + `domain id`, `group id`, `context id` | `http://trans.eu/xmpp/context` | freight context (v2) |
| `event` | `http://trans.eu/xmpp/trans_events` | negotiation events and notifications (not text) |
| `file`, `sms_sent` | `http://trans.eu/xmpp/...` | non-text |
| `delay` | `urn:xmpp:delay` | offline / old |

Own messages from other sessions arrive as carbons (`urn:xmpp:carbons:2`, `<sent>`).

### Sending (`sendTextMessage` in `messenger.service.js`)
Note `type="normal"`, not `chat`:

```xml
<message xmlns="jabber:client" id="UUID" to="PEER@trans.eu" type="normal">
  <body>text</body>
  <request xmlns="http://trans.eu/xmpp/message_status"/>
  <context xmlns="urn:trans.eu:xmpp:context" id="DOMAIN"><owner id="OWNER"/><context-item id="CTX"/></context>
  <context xmlns="http://trans.eu/xmpp/context"><domain id="DOMAIN"/><context id="CTX"/></context>
</message>
```
The v1 block is sent when context id and owner id are both known. The v2 block omits `group`.
Server confirms with `<created xmlns="http://trans.eu/xmpp/message_status"><message-id id="UUID"/></created>`.

---

## Design decision: reuse the page's session

The extension injects a script into the page that wraps `WebSocket` (and, for TIMOCOM, reads the
Stream auth header). It reads incoming messages from the connection the user is **already logged
into**, and replies through it. Trans.eu: same socket. TIMOCOM: same Stream credentials, `fetch` from the page.

- Tokens stay in page memory. The extension never stores, forwards or refreshes them.
- Login, refresh, Cloudflare and Origin checks are handled by the site itself.
- **Cost:** a logged-in tab must stay open.
- Trans.eu stream management: the server also counts our injected stanza. stanza.js `process()` only
  trims its unacked queue by the difference and then stores the server's `h`, so counting resyncs.
  In a rare race one of the page's own pending stanzas could be marked acked early.
- Trans.eu does not echo a message to the session that sent it, so the open chat window probably
  won't show an automatic reply until history reloads (unverified).
