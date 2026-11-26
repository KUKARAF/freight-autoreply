// Runs in the page (MAIN world) on platform.trans.eu. Taps the page's own authenticated
// XMPP-over-WebSocket connection. No token is read, stored or sent anywhere.
(() => {
  "use strict";
  const FROM_BRIDGE = "freight-reply:bridge";
  const TO_BRIDGE = "freight-reply:ext";
  const NS = {
    client: "jabber:client",
    sid: "urn:xmpp:sid:0",
    delay: "urn:xmpp:delay",
    carbons: "urn:xmpp:carbons:2",
    forward: "urn:xmpp:forward:0",
    bind: "urn:ietf:params:xml:ns:xmpp-bind",
    status: "http://trans.eu/xmpp/message_status",
    ctx1: "urn:trans.eu:xmpp:context",
    ctx2: "http://trans.eu/xmpp/context",
    events: "http://trans.eu/xmpp/trans_events",
    meta: "http://trans.eu/xmpp/message_metadata",
    file: "http://trans.eu/xmpp/file",
    sms: "http://trans.eu/xmpp/sms_sent",
  };
  const HISTORY_LIMIT = 12;
  // Marks our replies, so another open tab does not mistake them for the user typing.
  const ID_PREFIX = "far-";

  const NativeWebSocket = window.WebSocket;
  const nativeSend = NativeWebSocket.prototype.send;
  const parser = new DOMParser();
  const post = window.postMessage.bind(window);
  const history = new Map(); // peer -> [{role, text}]
  const waiting = new Map(); // message id -> resolve
  let socket = null;
  let myJid = null;

  const emit = (type, payload, extra) =>
    post({ channel: FROM_BRIDGE, type, payload, ...extra }, location.origin);
  const bare = (jid) => (jid || "").split("/")[0];
  const child = (el, name, ns) =>
    [...el.children].find((c) => c.localName === name && (!ns || c.namespaceURI === ns)) || null;
  const attr = (el, name, ns, a) => (el && child(el, name, ns)?.getAttribute(a)) || null;

  function remember(peer, role, text) {
    const list = history.get(peer) || [];
    list.push({ role, text });
    history.set(peer, list.slice(-HISTORY_LIMIT));
  }

  function parseStanza(data) {
    if (typeof data !== "string" || !/^\s*<(message|iq)[\s>]/.test(data)) return null;
    const doc = parser.parseFromString(data, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    return doc.documentElement;
  }

  function readContext(msg) {
    const ref = {};
    const v1 = child(msg, "context", NS.ctx1);
    if (v1) {
      ref.v1 = {
        domainId: v1.getAttribute("id"),
        ownerId: attr(v1, "owner", null, "id"),
        itemId: attr(v1, "context-item", null, "id"),
      };
    }
    const v2 = child(msg, "context", NS.ctx2);
    if (v2) {
      ref.v2 = { domainId: attr(v2, "domain", null, "id"), contextId: attr(v2, "context", null, "id") };
    }
    return ref;
  }

  // A message the user (page UI or another device) wrote to someone.
  function handleOwn(msg) {
    const body = child(msg, "body")?.textContent;
    const peer = bare(msg.getAttribute("to"));
    if (!peer || !body) return;
    remember(peer, "me", body);
    if (msg.getAttribute("id")?.startsWith(ID_PREFIX)) return;
    emit("own", { platform: "transeu", peerId: peer, id: msg.getAttribute("id") });
  }

  function handleMessage(msg, isCarbon) {
    const type = msg.getAttribute("type");
    const id = msg.getAttribute("id");

    if (!isCarbon) {
      const created = child(msg, "created", NS.status);
      const createdId = created && attr(created, "message-id", null, "id");
      if (createdId) waiting.get(createdId)?.({ ok: true });
      if (type === "error") {
        const cond = child(msg, "error")?.firstElementChild?.localName || "error";
        waiting.get(id)?.({ ok: false, error: `Trans.eu rejected the message (${cond})` });
        return;
      }
      for (const dir of ["sent", "received"]) {
        const carbon = child(msg, dir, NS.carbons);
        if (!carbon) continue;
        // Only the user's own server may wrap messages in carbons.
        const outer = bare(msg.getAttribute("from"));
        if (outer !== bare(msg.getAttribute("to")) || (myJid && outer !== myJid)) return;
        const fwd = child(carbon, "forwarded", NS.forward);
        const inner = fwd && child(fwd, "message");
        if (!inner) return;
        if (dir === "sent") handleOwn(inner);
        else handleMessage(inner, true);
        return;
      }
    }

    const body = child(msg, "body")?.textContent;
    const from = bare(msg.getAttribute("from"));
    const to = bare(msg.getAttribute("to"));
    if (!body || !body.trim() || !from || type === "groupchat" || type === "error") return;
    if (myJid && from === myJid) return handleOwn(msg);
    if (!from.endsWith("@trans.eu")) return;
    if (
      child(msg, "delay", NS.delay) ||
      child(msg, "event", NS.events) ||
      child(msg, "file", NS.file) ||
      child(msg, "sms_sent", NS.sms)
    ) {
      return;
    }
    if (!myJid && to) myJid = to;

    const ref = readContext(msg);
    const contextId = ref.v2?.contextId || ref.v1?.itemId || "";
    const meta = child(msg, "meta", NS.meta);
    const accountId = meta
      ? [...meta.children].find((i) => i.getAttribute("name") === "from_account_id")?.getAttribute("value")
      : null;
    const prior = history.get(from) || [];
    remember(from, "them", body);

    emit("incoming", {
      platform: "transeu",
      id: attr(msg, "stanza-id", NS.sid, "id") || id,
      peerId: from,
      conversationId: `${from}|${contextId}`,
      senderName: "",
      text: body,
      history: prior,
      context: { contextId, senderAccountId: accountId },
      replyRef: { to: from, ...ref },
    });
  }

  function onFrame(data) {
    const el = parseStanza(data);
    if (!el) return;
    if (el.localName === "iq") {
      const bind = child(el, "bind", NS.bind);
      const jid = bind && child(bind, "jid")?.textContent;
      if (jid) myJid = bare(jid);
    } else if (el.localName === "message") {
      handleMessage(el, false);
    }
  }

  // Characters XML 1.0 forbids would make the server drop the whole stream.
  const xmlText = (s) =>
    String(s)
      .toWellFormed()
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");

  function buildMessage(id, ref, text) {
    let xml =
      `<message xmlns="${NS.client}" id="${xmlText(id)}" to="${xmlText(ref.to)}" type="normal">` +
      `<body>${xmlText(text)}</body><request xmlns="${NS.status}"/>`;
    const { v1, v2 } = ref;
    if (v1?.itemId && v1?.ownerId) {
      xml +=
        `<context xmlns="${NS.ctx1}" id="${xmlText(v1.domainId || "")}">` +
        `<owner id="${xmlText(v1.ownerId)}"/><context-item id="${xmlText(v1.itemId)}"/></context>`;
    }
    if (v2?.domainId && v2?.contextId) {
      xml +=
        `<context xmlns="${NS.ctx2}"><domain id="${xmlText(v2.domainId)}"/>` +
        `<context id="${xmlText(v2.contextId)}"/></context>`;
    }
    return `${xml}</message>`;
  }

  const isConnected = () => !!socket && socket.readyState === NativeWebSocket.OPEN && !!myJid;

  function send(replyRef, text) {
    if (!isConnected()) return Promise.resolve({ ok: false, error: "chat connection is not open" });
    if (!/^[\w.-]+@trans\.eu$/.test(replyRef?.to || "") || !text?.trim()) {
      return Promise.resolve({ ok: false, error: "invalid recipient or empty text" });
    }
    const id = ID_PREFIX + crypto.randomUUID();
    return new Promise((resolve) => {
      const done = (r) => {
        clearTimeout(timer);
        waiting.delete(id);
        if (r.ok) remember(replyRef.to, "me", text);
        resolve(r);
      };
      const timer = setTimeout(() => done({ ok: true, unconfirmed: true }), 8000);
      waiting.set(id, done);
      nativeSend.call(socket, buildMessage(id, replyRef, text));
    });
  }

  function tap(ws) {
    socket = ws;
    ws.addEventListener("message", (ev) => {
      try {
        onFrame(ev.data);
      } catch (e) {
        console.warn("[freight-reply] could not handle stanza", e);
      }
    });
    // Observe what the page itself sends, to notice when the user answers by hand.
    // Our own replies go through nativeSend and skip this.
    ws.send = function (data) {
      try {
        const el = parseStanza(data);
        if (el?.localName === "message" && el.getAttribute("type") !== "error") handleOwn(el);
      } catch (e) {
        console.warn("[freight-reply] could not inspect outgoing stanza", e);
      }
      return nativeSend.call(this, data);
    };
  }

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      try {
        const url = new URL(String(args[0]), location.href);
        if (url.hostname === "xmpp-ejabberd.platform.trans.eu") tap(ws);
      } catch {
        /* not a URL we care about */
      }
      return ws;
    },
  });

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.channel !== TO_BRIDGE) return;
    // Frames without a chat connection stay silent so the frame that has one can answer.
    if (!socket) return;
    if (d.type === "ping") emit("result", null, { reqId: d.reqId, ok: isConnected() });
    if (d.type === "send") emit("result", null, { reqId: d.reqId, ...(await send(d.replyRef, d.text)) });
  });
})();
