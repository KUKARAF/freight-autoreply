// Chat text is untrusted: it is only ever inserted with textContent.
const $ = (id) => document.getElementById(id);
const call = (type, extra) => browser.runtime.sendMessage({ from: "ui", type, ...extra });

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

const NAMES = { transeu: "Trans.eu", timocom: "TIMOCOM" };
let settings;
let renderedDrafts = "";

function draftCard(d) {
  const box = el("textarea", { rows: 3, value: d.text });
  const error = el("div", { className: "warn" });
  const sendBtn = el("button", { className: "primary", textContent: "Send" });
  sendBtn.onclick = async () => {
    sendBtn.disabled = true;
    const r = await call("approveDraft", { draftId: d.draftId, text: box.value });
    if (!r.ok) error.textContent = r.error;
    await refresh();
  };
  const discard = el("button", { textContent: "Discard" });
  discard.onclick = () => call("discardDraft", { draftId: d.draftId }).then(refresh);
  return el(
    "div",
    { className: "card" },
    el("div", { className: "muted", textContent: `${NAMES[d.msg.platform]} · ${d.msg.senderName || d.msg.peerId} · ${d.source}` }),
    el("div", { className: "quote", textContent: d.msg.text }),
    box,
    el("div", { className: "warn", textContent: d.note || "" }),
    error,
    el("div", { className: "row" }, sendBtn, discard),
  );
}

async function refresh() {
  const data = await call("getAll");
  settings = data.settings;
  const { state } = data;
  $("enabled").checked = settings.enabled;
  $("autoSend").checked = settings.autoSend;
  $("payment").hidden = !state.paymentUrl;
  if (state.paymentUrl) $("paymentLink").href = state.paymentUrl;

  // Re-rendering would wipe text being edited, so only do it when the draft list changes.
  const key = JSON.stringify(state.drafts.map((d) => [d.draftId, d.note]));
  if (key !== renderedDrafts) {
    renderedDrafts = key;
    $("drafts").replaceChildren(
      ...(state.drafts.length ? state.drafts.map(draftCard) : [el("div", { className: "muted", textContent: "None" })]),
    );
  }

  $("log").replaceChildren(
    ...state.log.slice(0, 25).map((e) =>
      el(
        "div",
        { className: "card" },
        el("div", { className: "muted", textContent: `${new Date(e.at).toLocaleTimeString()} · ${NAMES[e.platform]} · ${e.from}` }),
        el("div", { className: "quote", textContent: e.text }),
        el("div", { textContent: e.detail ? `${e.outcome}: ${e.detail}` : e.outcome }),
      ),
    ),
  );
}

for (const key of ["enabled", "autoSend"]) {
  $(key).onchange = async (ev) => {
    await call("saveSettings", { settings: { ...settings, [key]: ev.target.checked } });
    await refresh();
  };
}
$("openOptions").onclick = () => browser.runtime.openOptionsPage();
$("clearLog").onclick = () => call("clearLog").then(refresh);
browser.storage.onChanged.addListener(refresh);
refresh();
