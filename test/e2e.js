// Loads the unmodified extension in headless Firefox together with the real web app. A local proxy
// answers for every host, so no request can reach the real sites. All data here is synthetic.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import webdriver from "selenium-webdriver";
import firefox from "selenium-webdriver/firefox.js";
import { WebSocketServer } from "ws";

const root = path.resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(path.join(os.tmpdir(), "far-e2e-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=mock",
  "-keyout", path.join(tmp, "key.pem"), "-out", path.join(tmp, "cert.pem")], { stdio: "ignore" });

const ME = "1000-1@trans.eu";
const PEER = "2000-1@trans.eu";
const frames = [];
const posts = [];
const sockets = {};

const pages = {
  "platform.trans.eu": `<script>window.ws=new WebSocket("wss://xmpp-ejabberd.platform.trans.eu/websocket","xmpp");
    window.got=[];ws.onmessage=e=>got.push(e.data);</script>`,
  "my.timocom.com": `<script>window.ws=new WebSocket("wss://chat.stream-io-api.com/connect?api_key=KEY&authorization=STREAMJWT&stream-auth-type=jwt&json="+encodeURIComponent(JSON.stringify({user_id:"111"})));</script>`,
};

// ---- the real web app, published as https://freight.osmosis.page through the proxy
const APP_PORT = 18765;
const appEnv = {
  ...process.env, UV_NO_CONFIG: "1", DATABASE_PATH: path.join(tmp, "app.db"),
  BASE_URL: "https://freight.osmosis.page", LLM_API_KEY: "",
};
const uv = { cwd: path.join(root, "server"), env: appEnv };
const created = execFileSync("uv", ["run", "python", "-m", "app.cli", "create-user", "e2e@example.com"], uv).toString();
const password = created.match(/password: (\S+)/)[1];
const webApp = spawn("uv", ["run", "uvicorn", "app.main:create_app", "--factory", "--port", String(APP_PORT)],
  { ...uv, stdio: ["ignore", "ignore", "pipe"], detached: true });
let appLog = "";
webApp.stderr.on("data", (d) => (appLog += d));

const server = https.createServer(
  { key: readFileSync(path.join(tmp, "key.pem")), cert: readFileSync(path.join(tmp, "cert.pem")) },
  (req, res) => {
    const host = req.headers.host.split(":")[0];
    if (host === "freight.osmosis.page") {
      const upstream = http.request(
        { host: "127.0.0.1", port: APP_PORT, path: req.url, method: req.method, headers: req.headers },
        (r) => (res.writeHead(r.statusCode, r.headers), r.pipe(res)),
      );
      upstream.on("error", () => res.writeHead(502).end());
      return req.pipe(upstream);
    }
    if (host === "chat.stream-io-api.com") {
      const cors = { "Access-Control-Allow-Origin": "https://my.timocom.com", "Access-Control-Allow-Headers": "*" };
      if (req.method === "OPTIONS") return res.writeHead(200, cors).end();
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        posts.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
        const id = JSON.parse(body).filter_conditions?.cid.$in[0];
        res.writeHead(200, { ...cors, "Content-Type": "application/json" });
        res.end(JSON.stringify(id ? { channels: [{ channel: { cid: id, tc_context_loadingPlaces_cities: ["Testowo", "Probne"],
          tc_context_useAiNegotiator: id.endsWith("aibot") }, messages: [] }] } : { message: {} }));
      });
      return;
    }
    res.writeHead(pages[host] ? 200 : 404, { "Content-Type": "text/html" });
    res.end(pages[host] || "");
  },
);
const wss = new WebSocketServer({ server, handleProtocols: (p) => p.values().next().value || false });
wss.on("connection", (ws, req) => {
  const host = req.headers.host.split(":")[0];
  sockets[host] = ws;
  ws.on("message", (d) => frames.push(String(d)));
  if (host === "chat.stream-io-api.com") {
    ws.send(JSON.stringify({ type: "health.check", connection_id: "c1", me: { id: "111", tc_profile_globalCompanyId: "77" } }));
  } else {
    ws.send(`<iq xmlns="jabber:client" type="result" id="b"><bind xmlns="urn:ietf:params:xml:ns:xmpp-bind"><jid>${ME}/t6-x</jid></bind></iq>`);
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));

const proxy = http.createServer((_req, res) => res.writeHead(404).end());
proxy.on("connect", (_req, client, head) => {
  const upstream = net.connect(server.address().port, "127.0.0.1", () => {
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    upstream.write(head);
    upstream.pipe(client).pipe(upstream);
  });
  upstream.on("error", () => client.destroy());
  client.on("error", () => upstream.destroy());
});
await new Promise((r) => proxy.listen(0, "127.0.0.1", r));
const port = proxy.address().port;

const UUID = "7b1f0c1e-3c2a-4a55-9d0e-1a2b3c4d5e6f";
const options = new firefox.Options().addArguments("-headless").setAcceptInsecureCerts(true);
const FIREFOX = process.env.FIREFOX || "/usr/lib64/firefox/firefox";
options.setBinary(FIREFOX);
for (const [k, v] of Object.entries({
  "network.proxy.type": 1,
  "network.proxy.http": "127.0.0.1", "network.proxy.http_port": port,
  "network.proxy.ssl": "127.0.0.1", "network.proxy.ssl_port": port,
  "network.proxy.no_proxies_on": "",
  "extensions.webextensions.uuids": JSON.stringify({ "freight-auto-reply@local": UUID }),
})) options.setPreference(k, v);
const driver = await new webdriver.Builder().forBrowser("firefox").setFirefoxOptions(options)
  .setFirefoxService(new firefox.ServiceBuilder().addArguments("--allow-system-access")).build();

async function openTab(url) {
  await driver.switchTo().newWindow("tab");
  await driver.get(url);
  return driver.getWindowHandle();
}
// WebDriver may not navigate to moz-extension: pages, so the browser UI loads them instead.
async function loadExtensionPage(page) {
  await driver.setContext(firefox.Context.CHROME);
  await driver.executeScript((url) => {
    const win = Services.wm.getMostRecentWindow("navigator:browser");
    win.gBrowser.selectedBrowser.loadURI(Services.io.newURI(url), {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
  }, `moz-extension://${UUID}/ui/${page}.html`);
  await driver.setContext(firefox.Context.CONTENT);
  await until(`${page} page`, async () =>
    (await driver.executeScript(() => document.readyState + location.href)) === `completemoz-extension://${UUID}/ui/${page}.html`);
}

// Runs code as a page script, so it sees the same globals the site would.
async function inPage(tab, code) {
  await driver.switchTo().window(tab);
  return driver.executeScript((src) => window.eval(src), code);
}

async function until(what, fn, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

try {
  await driver.installAddon(path.join(root, "extension"), true);
  await driver.switchTo().newWindow("tab");
  const ui = await driver.getWindowHandle();
  // The chrome context acts on the selected tab, so select it first.
  await driver.switchTo().window(ui);
  await loadExtensionPage("popup");
  const call = async (type, extra = {}) => {
    const back = await driver.getWindowHandle();
    await driver.switchTo().window(ui);
    const r = await driver.executeAsyncScript((m, done) => {
      const api = window.wrappedJSObject?.browser || window.browser || browser;
      api.runtime.sendMessage(typeof cloneInto === "function" ? cloneInto(m, window) : m).then(
        (v) => done(JSON.parse(JSON.stringify(v ?? null))), (e) => done({ error: String(e) }));
    }, { from: "ui", type, ...extra });
    await driver.switchTo().window(back);
    return r;
  };
  // ---- web app: log in, change the first rule, try it, create an access key
  await until("web app", () => new Promise((resolve) =>
    http.get(`http://127.0.0.1:${APP_PORT}/healthz`, (r) => resolve(r.statusCode === 200)).on("error", () => resolve(false))), 30000);
  const { By, until: when } = webdriver;
  const find = (css) => driver.wait(when.elementLocated(By.css(css)), 10000);
  const click = async (css) => {
    const element = await find(css);
    await driver.executeScript("arguments[0].scrollIntoView({block: 'center'})", element);
    await element.click();
  };
  const type = async (css, value) => {
    const element = await find(css);
    await element.clear();
    await element.sendKeys(value);
  };
  await openTab("https://freight.osmosis.page/");
  await type("input[name=email]", "e2e@example.com");
  await type("input[name=password]", password);
  await click("form button.primary");
  await type('input[name="available.keywords"]', "dostepne");
  await type('textarea[name="available.reply"]', 'Tak <&> "ok"');
  await click('select[name="available.send"] option[value="auto"]');
  await click(".savebar button");
  await find("p.ok");
  await type('form[action="/test"] textarea', "Czy dostępne?");
  await click('form[action="/test"] button');
  const tested = await (await find("#test-result")).getText();
  assert.match(tested, /Tak <&> "ok"[\s\S]*sent automatically/);
  if (process.env.SHOTS) {
    writeFileSync(path.join(process.env.SHOTS, "dashboard.png"), await driver.takeScreenshot(), "base64");
  }
  await click('form[action="/api-key"] button');
  const apiKey = await (await find("#new-key")).getText();
  console.log("web app: login, rule edit, test box, access key OK");

  const backend = { baseUrl: "https://freight.osmosis.page", apiKey };
  assert.deepEqual(await call("checkConnection", { backend }), { ok: true, email: "e2e@example.com", aiConfigured: false });
  const { settings } = await call("getAll");
  await call("saveSettings", {
    settings: {
      ...settings, enabled: true, autoSend: true, backend,
      limits: { ...settings.limits, delayMinSec: 0, delayMaxSec: 0, cooldownSec: 0 },
    },
  });

  // ---- Trans.eu
  const trans = await openTab("https://platform.trans.eu/freights/sent");
  await until("xmpp socket", () => sockets["xmpp-ejabberd.platform.trans.eu"]);
  const xmpp = sockets["xmpp-ejabberd.platform.trans.eu"];
  const incoming = (id, extra = "", from = PEER) =>
    `<message xmlns="jabber:client" id="${id}" from="${from}/t6-p" to="${ME}" type="normal"><body>Czy dostępne?</body>` +
    `<stanza-id xmlns="urn:xmpp:sid:0" id="s-${id}" by="${ME}"/>${extra}</message>`;
  await until("bind frame in page", () => inPage(trans, "got.length"));
  xmpp.send(incoming("old", `<delay xmlns="urn:xmpp:delay" stamp="2020-01-01T00:00:00Z"/>`));
  xmpp.send(incoming("m1",
    `<context xmlns="urn:trans.eu:xmpp:context" id="dom"><owner id="42"/><context-item id="item1"/></context>` +
    `<context xmlns="http://trans.eu/xmpp/context"><domain id="dom"/><group id="g"/><context id="item1"/></context>`));
  const reply = await until("xmpp reply", () => frames.find((f) => f.includes("<body>")));
  console.log("trans.eu reply stanza:\n ", reply);
  assert.match(reply, new RegExp(`to="${PEER}" type="normal"`));
  assert.match(reply, /<body>Tak &lt;&amp;&gt; &quot;ok&quot;<\/body>/);
  assert.match(reply, /<owner id="42"\/><context-item id="item1"\/>/);
  assert.match(reply, /<domain id="dom"\/><context id="item1"\/><\/context><\/message>$/);
  const replyId = reply.match(/ id="([^"]+)"/)[1];
  xmpp.send(`<message xmlns="jabber:client" from="${ME}" to="${ME}/t6-x"><created xmlns="http://trans.eu/xmpp/message_status" date="x"><message-id id="${replyId}"/></created></message>`);
  await until("sent log", async () => (await call("getAll")).state.log.find((e) => e.outcome === "sent"));
  assert.equal(frames.filter((f) => f.includes("<body>")).length, 1, "delayed message must not be answered");

  // A second tab sees our reply as a carbon: that must not count as the user typing.
  xmpp.send(`<message xmlns="jabber:client" from="${ME}" to="${ME}/t6-x"><sent xmlns="urn:xmpp:carbons:2"><forwarded xmlns="urn:xmpp:forward:0">` +
    `<message xmlns="jabber:client" id="${replyId}" from="${ME}/t6-other" to="${PEER}"><body>Tak</body></message></forwarded></sent></message>`);
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual((await call("getAll")).state.quiet, {});

  // The user writes by hand in the page: the contact must go quiet.
  const human = `<message xmlns="jabber:client" to="${PEER}" type="normal" id="human"><body>ja odpowiem</body></message>`;
  await inPage(trans, `ws.send(${JSON.stringify(human)})`);
  await until("human frame", () => frames.find((f) => f.includes("ja odpowiem")));
  await new Promise((r) => setTimeout(r, 300));
  xmpp.send(incoming("m2"));
  await until("quiet skip", async () => (await call("getAll")).state.log.find((e) => e.outcome === "skipped"));
  console.log("trans.eu: reply, escaping, context, delay filter, manual-reply quiet period OK");

  // ---- TIMOCOM
  await openTab("https://my.timocom.com/app/tccargo/");
  await until("stream socket", () => sockets["chat.stream-io-api.com"]);
  const stream = sockets["chat.stream-io-api.com"];
  await new Promise((r) => setTimeout(r, 500));
  const event = (id, cid, user = { id: "222", tc_profile_firstName: "Jan", tc_profile_globalCompanyId: "88" }) =>
    JSON.stringify({ type: "message.new", cid, message: { id, type: "regular", text: "Czy dostępne?", user, created_at: new Date().toISOString() } });
  const sentPosts = () => posts.filter((p) => p.url.includes("/message?"));

  stream.send(event("t1", "messaging:chan1"));
  const post = await until("stream send", () => sentPosts()[0]);
  assert.match(post.url, /^\/channels\/messaging\/chan1\/message\?api_key=KEY&user_id=111$/);
  assert.equal(post.auth, "STREAMJWT");
  assert.equal(post.body.message.text, 'Tak <&> "ok"');

  stream.send(event(post.body.message.id, "messaging:chan1", { id: "111" })); // echo of our own reply
  await new Promise((r) => setTimeout(r, 500));
  assert.equal((await call("getAll")).state.quiet["timocom:messaging:chan1"], undefined);
  stream.send(event("t2", "messaging:aibot"));
  stream.send(event("t3", "notification:sys"));
  stream.send(event("t4", "messaging:chan2", { id: "333", tc_profile_globalCompanyId: "77" })); // colleague
  await until("negotiator skip", async () => (await call("getAll")).state.log.find((e) => /Negotiator/.test(e.detail)));
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(sentPosts().length, 1);
  console.log("timocom: reply, AI-negotiator skip, system-channel and colleague filters OK");

  const { state } = await call("getAll");
  assert.doesNotMatch(JSON.stringify(state), /STREAMJWT/, "token must never reach extension storage");

  // ---- UI renders without errors
  await driver.switchTo().window(ui);
  for (const page of ["options", "popup"]) {
    await loadExtensionPage(page);
    const selector = page === "options" ? "#check" : "#log .card";
    await until(`${page} render`, async () => (await driver.findElements(webdriver.By.css(selector))).length);
    if (process.env.SHOTS) {
      writeFileSync(path.join(process.env.SHOTS, `${page}.png`), await driver.takeScreenshot(), "base64");
    }
  }
  console.log("ui renders OK\nE2E PASSED");
} catch (e) {
  console.error(e);
  console.error("frames:", frames);
  console.error("web app log:", appLog.slice(-3000));
  process.exitCode = 1;
} finally {
  await driver.quit();
  proxy.close();
  server.close();
  wss.close();
  try { process.kill(-webApp.pid); } catch { /* already gone */ }
  rmSync(tmp, { recursive: true, force: true });
  process.exit();
}
