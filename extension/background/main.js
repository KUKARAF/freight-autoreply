import { Engine } from "../lib/engine.js";
import { checkConnection, requestDecision } from "../lib/backend.js";
import { PLATFORM_BY_HOST, sanitizeEvent } from "../lib/validate.js";

const TAB_PATTERNS = {
  transeu: "https://platform.trans.eu/*",
  timocom: "https://my.timocom.com/*",
};

// Prefers the tab the message came from; falls back to any other tab with a live chat connection.
async function sendThroughPage(platform, preferredTabId, replyRef, text) {
  const tabs = await browser.tabs.query({ url: TAB_PATTERNS[platform] });
  const ids = tabs.map((t) => t.id).sort((a, b) => (b === preferredTabId) - (a === preferredTabId));
  for (const tabId of ids) {
    const alive = await browser.tabs.sendMessage(tabId, { type: "ping" }).catch(() => null);
    if (!alive?.ok) continue;
    // Only one attempt: after a failed send we cannot be sure nothing left the browser.
    return browser.tabs
      .sendMessage(tabId, { type: "send", replyRef, text })
      .catch((e) => ({ ok: false, uncertain: true, error: e.message }));
  }
  return { ok: false, error: "no open, logged-in tab with a live chat connection" };
}

const engine = new Engine({
  storage: browser.storage.local,
  send: sendThroughPage,
  askBackend: requestDecision,
  onChange: (e) => {
    const n = e.state.drafts.length;
    browser.action.setBadgeText({ text: !e.settings.enabled ? "off" : n ? String(n) : "" });
    browser.action.setBadgeBackgroundColor({ color: !e.settings.enabled ? "#6b7280" : "#d97706" });
  },
});
engine.ready.then(() => engine.onChange(engine));

const UI_ACTIONS = {
  async getAll() {
    await engine.ready;
    return { settings: engine.settings, state: engine.state };
  },
  saveSettings: (m) => engine.saveSettings(m.settings),
  approveDraft: (m) => engine.approveDraft(m.draftId, m.text),
  discardDraft: (m) => engine.discardDraft(m.draftId),
  clearLog: () => engine.clearLog(),
  checkConnection: (m) =>
    checkConnection(m.backend).then(
      (me) => ({ ok: true, email: String(me.email || ""), aiConfigured: me.aiConfigured === true }),
      (e) => ({ ok: false, error: e.message }),
    ),
};

browser.runtime.onMessage.addListener((message, sender) => {
  if (sender.id !== browser.runtime.id) return undefined;

  if (message?.from === "relay") {
    const platform = sender.tab && PLATFORM_BY_HOST[new URL(sender.url).hostname];
    const event = platform && sanitizeEvent(message.type, message.payload, platform);
    if (!event) return undefined;
    return message.type === "own" ? engine.handleOwn(event) : engine.handleIncoming(event, sender.tab.id);
  }

  // Settings and sending are only reachable from the extension's own pages.
  if (message?.from === "ui" && sender.url?.startsWith(browser.runtime.getURL(""))) {
    return UI_ACTIONS[message.type]?.(message);
  }
  return undefined;
});
