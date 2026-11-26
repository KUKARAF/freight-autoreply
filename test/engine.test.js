import { test } from "node:test";
import assert from "node:assert/strict";
import { Engine } from "../extension/lib/engine.js";
import { DEFAULT_SETTINGS, withDefaults } from "../extension/lib/settings.js";
import { requestDecision, normalizeBaseUrl } from "../extension/lib/backend.js";
import { sanitizeEvent } from "../extension/lib/validate.js";

const reply = (over = {}) => ({ action: "reply", text: "Tak", autoSend: true, source: "rule: avail", note: "", ...over });

function setup({ settings = {}, sendResult = { ok: true }, answer = reply(), ask, sleep } = {}) {
  let clock = 1_000_000_000;
  const sent = [];
  const asked = [];
  const store = {};
  const base = withDefaults({
    enabled: true, autoSend: true,
    ...settings,
    limits: { ...DEFAULT_SETTINGS.limits, delayMinSec: 0, delayMaxSec: 0, cooldownSec: 60, ...settings.limits },
  });
  const engine = new Engine({
    storage: {
      get: async () => structuredClone({ settings: base, ...store }),
      set: async (v) => Object.assign(store, structuredClone(v)),
    },
    send: async (...a) => (sent.push(a), sendResult),
    askBackend: async (...a) => (asked.push(a), ask ? ask(...a) : answer),
    now: () => clock,
    sleep: sleep || (async () => {}),
  });
  let n = 0;
  const msg = (over = {}) => ({
    platform: "transeu", id: `m${++n}`, peerId: "2-1@trans.eu", conversationId: "2-1@trans.eu|c",
    text: "Czy ładunek dostępne?", history: [], context: {}, replyRef: { to: "2-1@trans.eu" }, ...over,
  });
  return { engine, sent, asked, msg, tick: (ms) => (clock += ms) };
}

test("matching rule sends once, even if two tabs report the message", async () => {
  const { engine, sent, msg } = setup();
  const m = msg();
  const results = await Promise.all([engine.handleIncoming(m, 1), engine.handleIncoming(m, 2)]);
  assert.deepEqual(results.sort(), ["duplicate", "sent"]);
  assert.equal(sent.length, 1);
});

test("defaults are off, and draft-only until auto-send is enabled", async () => {
  assert.equal(DEFAULT_SETTINGS.enabled, false);
  assert.equal(DEFAULT_SETTINGS.autoSend, false);
  const off = setup({ settings: { enabled: false } });
  assert.equal(await off.engine.handleIncoming(off.msg(), 1), "disabled");
  const draft = setup({ settings: { autoSend: false } });
  assert.equal(await draft.engine.handleIncoming(draft.msg(), 1), "draft");
  assert.equal(draft.sent.length, 0);
  const id = draft.engine.state.drafts[0].draftId;
  const [a, b] = await Promise.all([draft.engine.approveDraft(id, "edited"), draft.engine.approveDraft(id, "edited")]);
  assert.equal(draft.sent.length, 1);
  assert.equal(draft.sent[0][3], "edited");
  assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
});

test("cooldown and daily limit turn replies into drafts", async () => {
  const { engine, sent, msg, tick } = setup();
  assert.equal(await engine.handleIncoming(msg(), 1), "sent");
  assert.equal(await engine.handleIncoming(msg(), 1), "draft");
  for (let i = 0; i < 2; i++) {
    tick(61_000);
    assert.equal(await engine.handleIncoming(msg(), 1), "sent");
  }
  tick(61_000);
  assert.equal(await engine.handleIncoming(msg(), 1), "draft");
  assert.equal(sent.length, 3);
});

test("parallel conversations cannot exceed the hourly limit", async () => {
  const { engine, sent, msg } = setup({ settings: { limits: { maxPerHour: 1 } } });
  await Promise.all([
    engine.handleIncoming(msg({ conversationId: "a" }), 1),
    engine.handleIncoming(msg({ conversationId: "b" }), 1),
  ]);
  assert.equal(sent.length, 1);
});

test("a manual reply silences the contact and cancels a pending send", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { engine, sent, msg } = setup({ sleep: () => gate });
  const pending = engine.handleIncoming(msg(), 1);
  await new Promise((r) => setImmediate(r));
  await engine.handleOwn({ platform: "transeu", peerId: "2-1@trans.eu" });
  release();
  assert.equal(await pending, "skipped");
  assert.equal(await engine.handleIncoming(msg(), 1), "skipped");
  assert.equal(sent.length, 0);
});

test("only the newest of two quick messages is answered", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { engine, sent, msg } = setup({ sleep: () => gate, settings: { limits: { cooldownSec: 0 } } });
  const a = engine.handleIncoming(msg(), 1);
  await new Promise((r) => setImmediate(r));
  const b = engine.handleIncoming(msg(), 1);
  await new Promise((r) => setImmediate(r));
  release();
  assert.deepEqual(await Promise.all([a, b]), ["skipped", "sent"]);
  assert.equal(sent.length, 1);
});

test("negotiator chats and old messages never reach the server", async () => {
  const { engine, sent, asked, msg } = setup();
  assert.equal(await engine.handleIncoming(msg({ context: { aiNegotiator: true } }), 1), "skipped");
  assert.equal(await engine.handleIncoming(msg({ timestamp: 5 }), 1), "old");
  assert.equal(sent.length + asked.length, 0);
});

test("the server decides: ignore, no reply, or suggest only", async () => {
  for (const [answer, outcome] of [
    [reply({ action: "ignore" }), "ignored"],
    [reply({ action: "none" }), "no reply"],
    [reply({ autoSend: false }), "draft"],
  ]) {
    const s = setup({ answer });
    assert.equal(await s.engine.handleIncoming(s.msg(), 1), outcome);
    assert.equal(s.sent.length, 0);
  }
});

test("first-message flag turns off once we have answered", async () => {
  const s = setup({ settings: { limits: { cooldownSec: 0 } } });
  await s.engine.handleIncoming(s.msg(), 1);
  await s.engine.handleIncoming(s.msg(), 1);
  await s.engine.handleIncoming(s.msg({ conversationId: "x", history: [{ role: "me", text: "hi" }] }), 1);
  assert.deepEqual(s.asked.map((a) => a[2]), [true, false, false]);
});

test("payment required is surfaced", async () => {
  const err = Object.assign(new Error("pay"), { name: "PaymentRequiredError", paymentUrl: "https://x.test/pay" });
  const s = setup({ ask: async () => { throw err; } });
  assert.equal(await s.engine.handleIncoming(s.msg(), 1), "error");
  assert.equal(s.engine.state.paymentUrl, "https://x.test/pay");
});

test("missing chat details force a draft", async () => {
  const a = setup();
  assert.equal(await a.engine.handleIncoming(a.msg({ detailsUnavailable: true }), 1), "draft");
});

test("a failed send becomes a draft, an uncertain one is never offered again", async () => {
  const a = setup({ sendResult: { ok: false, error: "closed" } });
  assert.equal(await a.engine.handleIncoming(a.msg(), 1), "draft");
  const b = setup({ sendResult: { ok: false, uncertain: true, error: "timeout" } });
  assert.equal(await b.engine.handleIncoming(b.msg(), 1), "unknown");
  assert.equal(b.engine.state.drafts.length, 0);
});

test("server client sends no ids or tokens, is strict about autoSend and handles 402", async () => {
  let seen;
  const msg = { platform: "timocom", id: "secret-id", text: "hi", replyRef: { id: "chan" }, history: [], context: { contextId: "offer" } };
  const backend = { baseUrl: "https://x.test/", apiKey: "k" };
  const decision = await requestDecision(backend, msg, true, async (url, init) => {
    seen = { url, init };
    return new Response(JSON.stringify({ action: "reply", text: " ok ", autoSend: "yes" }));
  });
  assert.deepEqual([decision.text, decision.autoSend], ["ok", false]);
  assert.equal(seen.url, "https://x.test/v1/decide");
  assert.doesNotMatch(seen.init.body, /secret-id|chan|offer/);
  await assert.rejects(
    requestDecision(backend, msg, true, async () => new Response('{"paymentUrl":"javascript:alert(1)"}', { status: 402 })),
    (e) => e.name === "PaymentRequiredError" && e.paymentUrl === null,
  );
  await assert.rejects(requestDecision(backend, msg, true, async () => new Response('{"action":"x"}')));
  assert.throws(() => normalizeBaseUrl("http://example.com"));
});

test("page events are validated against the tab's platform", () => {
  const p = { platform: "timocom", id: "1", peerId: "c", conversationId: "c", text: "x", replyRef: { type: "messaging", id: "c", extra: 1 } };
  assert.equal(sanitizeEvent("incoming", p, "transeu"), null);
  assert.deepEqual(sanitizeEvent("incoming", p, "timocom").replyRef, { type: "messaging", id: "c" });
});
