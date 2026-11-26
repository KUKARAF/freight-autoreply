// Decides what happens to each incoming message. Browser APIs are injected so it runs under node tests.
import { withDefaults } from "./settings.js";

const DAY = 24 * 3600_000;
const HOUR = 3600_000;
const MAX_AGE = 5 * 60_000;

const emptyState = () => ({
  seen: [], // processed message keys (also stops two open tabs answering twice)
  conversations: {}, // key -> {sent: [timestamps], answered: bool, touched}
  quiet: {}, // peer key -> timestamp of the user's last own message
  sentTimes: [],
  drafts: [],
  log: [],
  paymentUrl: null,
});

export class Engine {
  constructor({ storage, send, askBackend, now = Date.now, sleep, random = Math.random, onChange = () => {} }) {
    Object.assign(this, { storage, sendToPage: send, askBackend, now, random, onChange });
    this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.latest = new Map(); // conversation key -> newest message id
    this.ready = this.load();
    this.writes = Promise.resolve();
  }

  async load() {
    const data = await this.storage.get(["settings", "state", "enabledAt"]);
    this.settings = withDefaults(data.settings);
    this.state = { ...emptyState(), ...data.state };
    this.enabledAt = data.enabledAt || 0;
  }

  persist() {
    this.writes = this.writes
      .then(() => this.storage.set({ settings: this.settings, state: this.state, enabledAt: this.enabledAt }))
      .catch((e) => console.error("could not save state", e));
    this.onChange(this);
    return this.writes;
  }

  async saveSettings(raw) {
    await this.ready;
    const next = withDefaults(raw);
    if (next.enabled && !this.settings.enabled) this.enabledAt = this.now();
    this.settings = next;
    return this.persist();
  }

  log(msg, outcome, detail = "") {
    this.state.log.unshift({
      at: this.now(),
      platform: msg.platform,
      from: msg.senderName || msg.peerId,
      text: String(msg.text || "").slice(0, 200),
      outcome,
      detail: String(detail).slice(0, 300),
    });
    this.state.log.length = Math.min(this.state.log.length, 100);
  }

  conversation(key) {
    const c = (this.state.conversations[key] ||= { sent: [], answered: false });
    c.touched = this.now();
    c.sent = c.sent.filter((t) => this.now() - t < DAY);
    return c;
  }

  prune() {
    const old = this.now() - 30 * DAY;
    for (const [k, c] of Object.entries(this.state.conversations)) {
      if (c.touched < old) delete this.state.conversations[k];
    }
    for (const [k, t] of Object.entries(this.state.quiet)) if (t < old) delete this.state.quiet[k];
    this.state.sentTimes = this.state.sentTimes.filter((t) => this.now() - t < HOUR);
    this.state.seen = this.state.seen.slice(-1000);
  }

  // Why an automatic send is not allowed right now, or null.
  blockReason(msg) {
    const { limits } = this.settings;
    const convo = this.conversation(`${msg.platform}:${msg.conversationId}`);
    if (this.isHumanActive(msg)) return "you replied to this contact recently";
    const lastSent = convo.sent.at(-1);
    if (lastSent !== undefined && this.now() - lastSent < limits.cooldownSec * 1000) return "cooldown";
    if (convo.sent.length >= limits.maxPerConversationPerDay) return "daily limit for this conversation";
    if (this.state.sentTimes.filter((t) => this.now() - t < HOUR).length >= limits.maxPerHour) {
      return "hourly limit";
    }
    return null;
  }

  isHumanActive(msg) {
    const t = this.state.quiet[`${msg.platform}:${msg.peerId}`];
    return t !== undefined && this.now() - t < this.settings.limits.humanQuietMin * 60_000;
  }

  async handleOwn({ platform, peerId }) {
    await this.ready;
    this.state.quiet[`${platform}:${peerId}`] = this.now();
    this.state.drafts = this.state.drafts.filter((d) => !(d.msg.platform === platform && d.msg.peerId === peerId));
    return this.persist();
  }

  async handleIncoming(msg, tabId) {
    await this.ready;
    const s = this.settings;
    if (!s.enabled || !s.platforms[msg.platform]) return "disabled";

    const seenKey = `${msg.platform}:${msg.id}`;
    if (this.state.seen.includes(seenKey)) return "duplicate";
    this.state.seen.push(seenKey);
    this.prune();

    if (msg.timestamp && (msg.timestamp < this.enabledAt || this.now() - msg.timestamp > MAX_AGE)) {
      await this.persist();
      return "old";
    }

    const convoKey = `${msg.platform}:${msg.conversationId}`;
    this.latest.set(convoKey, msg.id);
    // A newer message makes the older draft outdated.
    this.state.drafts = this.state.drafts.filter((d) => `${d.msg.platform}:${d.msg.conversationId}` !== convoKey);

    const finish = async (outcome, detail) => {
      this.log(msg, outcome, detail);
      await this.persist();
      return outcome;
    };

    if (msg.context?.aiNegotiator) return finish("skipped", "TIMOCOM AI Negotiator is active in this chat");
    if (this.isHumanActive(msg)) return finish("skipped", "you replied to this contact recently");

    const isFirst = !this.conversation(convoKey).answered && !(msg.history || []).some((h) => h.role === "me");
    await this.persist();
    let decision;
    try {
      decision = await this.askBackend(s.backend, msg, isFirst);
    } catch (e) {
      if (e.name === "PaymentRequiredError") this.state.paymentUrl = e.paymentUrl || s.backend.baseUrl;
      return finish("error", e.message);
    }
    this.state.paymentUrl = null;
    const { text, source } = decision;
    if (decision.action === "ignore") return finish("ignored", source);
    if (decision.action === "none") {
      return finish("no reply", decision.note ? `${source} (${decision.note})` : source);
    }
    let mayAutoSend = decision.autoSend;
    let note = decision.note;

    // Asking the server takes a while: the situation may have changed meanwhile.
    const stale = this.staleReason(msg);
    if (stale) return finish("skipped", stale);

    if (msg.detailsUnavailable) {
      mayAutoSend = false;
      note = "chat details could not be loaded";
    }
    if (!this.settings.autoSend || !mayAutoSend) {
      return this.addDraft(msg, tabId, text, source, note);
    }

    const blocked = this.blockReason(msg);
    if (blocked) return this.addDraft(msg, tabId, text, source, blocked);

    const { delayMinSec, delayMaxSec } = this.settings.limits;
    // Reserve the slot before waiting so parallel messages cannot exceed the limits.
    const release = this.reserve(msg);
    await this.persist();
    await this.sleep((delayMinSec + this.random() * Math.max(0, delayMaxSec - delayMinSec)) * 1000);

    const changed =
      this.staleReason(msg) || (!this.settings.enabled || !this.settings.autoSend ? "auto-send was turned off" : null);
    if (changed) {
      release();
      return finish("skipped", changed);
    }

    const result = await this.sendToPage(msg.platform, tabId, msg.replyRef, text);
    if (result.ok) {
      return finish("sent", `${source}: ${text}${result.unconfirmed ? " (not confirmed by server)" : ""}`);
    }
    if (result.uncertain) return finish("unknown", `may or may not have been sent, check the chat: ${result.error}`);
    release();
    return this.addDraft(msg, tabId, text, source, `send failed: ${result.error}`);
  }

  staleReason(msg) {
    if (this.isHumanActive(msg)) return "you replied while the reply was being prepared";
    if (this.latest.get(`${msg.platform}:${msg.conversationId}`) !== msg.id) return "a newer message arrived";
    return null;
  }

  reserve(msg) {
    const at = this.now();
    const convo = this.conversation(`${msg.platform}:${msg.conversationId}`);
    const wasAnswered = convo.answered;
    convo.sent.push(at);
    convo.answered = true;
    this.state.sentTimes.push(at);
    return () => {
      const i = convo.sent.lastIndexOf(at);
      if (i >= 0) convo.sent.splice(i, 1);
      const j = this.state.sentTimes.lastIndexOf(at);
      if (j >= 0) this.state.sentTimes.splice(j, 1);
      convo.answered = wasAnswered;
    };
  }

  async addDraft(msg, tabId, text, source, note) {
    const { history, ...slim } = msg;
    this.state.drafts.unshift({ draftId: `${msg.platform}:${msg.id}`, msg: slim, tabId, text, source, note, at: this.now() });
    this.state.drafts.length = Math.min(this.state.drafts.length, 50);
    this.log(msg, "draft", note ? `${source} (${note})` : source);
    await this.persist();
    return "draft";
  }

  // The user pressed "Send" on a draft, so limits do not apply.
  async approveDraft(draftId, editedText) {
    await this.ready;
    const i = this.state.drafts.findIndex((d) => d.draftId === draftId);
    if (i < 0) return { ok: false, error: "draft no longer exists" };
    const text = String(editedText ?? this.state.drafts[i].text).trim();
    if (!text) return { ok: false, error: "reply is empty" };
    const [draft] = this.state.drafts.splice(i, 1); // removed first so a double click cannot send twice
    await this.persist();
    const result = await this.sendToPage(draft.msg.platform, draft.tabId, draft.msg.replyRef, text);
    if (result.ok) {
      this.reserve(draft.msg);
      this.log(draft.msg, "sent", `approved: ${text}`);
    } else if (result.uncertain) {
      this.log(draft.msg, "unknown", `may or may not have been sent, check the chat: ${result.error}`);
    } else {
      this.state.drafts.unshift({ ...draft, text, note: `send failed: ${result.error}` });
    }
    await this.persist();
    return result;
  }

  async discardDraft(draftId) {
    await this.ready;
    this.state.drafts = this.state.drafts.filter((d) => d.draftId !== draftId);
    return this.persist();
  }

  async clearLog() {
    await this.ready;
    this.state.log = [];
    return this.persist();
  }
}
