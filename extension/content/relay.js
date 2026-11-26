// Isolated-world relay between the page bridge (MAIN world) and the background script.
// Everything coming from the page is untrusted: the background re-validates it.
(() => {
  "use strict";
  const FROM_BRIDGE = "freight-reply:bridge";
  const TO_BRIDGE = "freight-reply:ext";
  const pending = new Map();

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.channel !== FROM_BRIDGE) return;
    if (d.type === "result") {
      pending.get(d.reqId)?.(d);
      return;
    }
    if (d.type === "incoming" || d.type === "own") {
      browser.runtime.sendMessage({ from: "relay", type: d.type, payload: d.payload }).catch(() => {});
    }
  });

  browser.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== "send" && msg?.type !== "ping") return undefined;
    const reqId = crypto.randomUUID();
    return new Promise((resolve) => {
      const done = (result) => {
        clearTimeout(timer);
        pending.delete(reqId);
        resolve(result);
      };
      // A send that times out may still have gone out, so it is marked uncertain (never retried).
      const timer = setTimeout(
        () => done({ ok: false, uncertain: msg.type === "send", error: "page did not answer" }),
        msg.type === "send" ? 25000 : 1000,
      );
      pending.set(reqId, done);
      window.postMessage(
        { channel: TO_BRIDGE, type: msg.type, reqId, replyRef: msg.replyRef, text: msg.text },
        location.origin,
      );
    });
  });
})();
