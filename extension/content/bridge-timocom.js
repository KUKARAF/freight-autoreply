// Runs in the page (MAIN world) on my.timocom.com. Watches the page's GetStream chat socket
// and replies with the same credentials. They stay in this closure and are never forwarded.
(() => {
  "use strict";
  const FROM_BRIDGE = "freight-reply:bridge";
  const TO_BRIDGE = "freight-reply:ext";
  const STREAM_HOST = "chat.stream-io-api.com";
  const HISTORY_LIMIT = 12;
  // Marks our replies, so another open tab does not mistake them for the user typing.
  const ID_PREFIX = "far-";

  const NativeWebSocket = window.WebSocket;
  const nativeFetch = window.fetch.bind(window);
  const post = window.postMessage.bind(window);
  const session = { apiKey: null, userId: null, token: null, companyId: null, socket: null };

  const emit = (type, payload, extra) =>
    post({ channel: FROM_BRIDGE, type, payload, ...extra }, location.origin);

  function streamUrl(path) {
    const url = new URL(`https://${STREAM_HOST}${path}`);
    url.searchParams.set("api_key", session.apiKey);
    url.searchParams.set("user_id", session.userId);
    return url.href;
  }

  async function streamPost(path, body) {
    const res = await nativeFetch(streamUrl(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: session.token,
        "stream-auth-type": "jwt",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw Object.assign(new Error(`chat API returned HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  // Own account, or a colleague from the same company writing in a shared channel.
  const isOurSide = (user) =>
    !!user &&
    (user.id === session.userId ||
      (!!session.companyId && String(user.tc_profile_globalCompanyId) === session.companyId));

  const displayName = (user) =>
    [user?.tc_profile_firstName, user?.tc_profile_lastName].filter(Boolean).join(" ") || user?.name || "";

  const first = (v) => (Array.isArray(v) ? v[0] : v) || "";
  const last = (v) => (Array.isArray(v) ? v[v.length - 1] : v) || "";

  function describeContext(ch, sender) {
    return {
      contextId: ch.tc_context_id || "",
      contextType: ch.tc_context_type || "",
      loadingCity: first(ch.tc_context_loadingPlaces_cities) || ch.tc_context_startAddress_city || "",
      unloadingCity:
        (ch.tc_context_loadingPlaces_cities?.length > 1 && last(ch.tc_context_loadingPlaces_cities)) ||
        last(ch.tc_context_destinationAddresses_cities),
      senderCompany: sender?.tc_profile_companyName || "",
      // TIMOCOM's own bot is answering this chat: we must stay out of it.
      aiNegotiator: !!(ch.tc_context_useAiNegotiator ?? ch.tc_context_aiNegotiatorEnabledAtCreation),
    };
  }

  async function handleIncoming(event) {
    const m = event.message;
    const cid = event.cid || event.channel?.cid;
    if (!m || !cid) return;
    const [type, id] = cid.split(":");
    if (type !== "messaging" || !id) return;
    if (m.type && m.type !== "regular" && m.type !== "reply") return;
    if (m.parent_id || m.tc_systemMessage_category || m.tc_systemMessage_context) return;
    if (String(m.id).startsWith(ID_PREFIX)) return;
    if (isOurSide(m.user)) {
      emit("own", { platform: "timocom", peerId: cid, id: m.id });
      return;
    }
    if (!m.text || !m.text.trim()) return;

    let state = null;
    try {
      const res = await streamPost("/channels", {
        filter_conditions: { cid: { $in: [cid] }, members: { $in: [session.userId] } },
        state: true,
        watch: false,
        presence: false,
        limit: 1,
        message_limit: HISTORY_LIMIT,
      });
      state = res.channels?.[0] || null;
    } catch (e) {
      console.warn("[freight-reply] could not load channel details", e);
    }
    const history = (state?.messages || [])
      .filter((x) => x.id !== m.id && x.text && x.type === "regular" && !x.tc_systemMessage_category)
      .filter((x) => !m.created_at || x.created_at <= m.created_at)
      .map((x) => ({ role: isOurSide(x.user) ? "me" : "them", text: x.text }));

    emit("incoming", {
      platform: "timocom",
      id: m.id,
      peerId: cid,
      conversationId: cid,
      senderName: displayName(m.user),
      senderFirstName: m.user?.tc_profile_firstName || "",
      text: m.text,
      timestamp: Date.parse(m.created_at) || undefined,
      history,
      // Without channel data we cannot rule out the AI negotiator, so the engine only drafts.
      detailsUnavailable: !state,
      context: describeContext(state?.channel || event.channel || {}, m.user),
      replyRef: { type, id },
    });
  }

  function onFrame(data) {
    if (typeof data !== "string") return;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (event.me?.id && String(event.me.id) === session.userId) {
      const company = event.me.tc_profile_globalCompanyId;
      if (company && String(company) !== "0") session.companyId = String(company);
    }
    if (event.type === "message.new" || event.type === "notification.message_new") {
      handleIncoming(event).catch((e) => console.warn("[freight-reply] could not handle message", e));
    }
  }

  function tap(ws, url) {
    const apiKey = url.searchParams.get("api_key");
    const token = url.searchParams.get("authorization");
    let userId = null;
    try {
      userId = String(JSON.parse(url.searchParams.get("json")).user_id);
    } catch {
      return;
    }
    if (!apiKey || !token || !userId) return;
    if (userId !== session.userId) session.companyId = null;
    Object.assign(session, { apiKey, token, userId, socket: ws });
    ws.addEventListener("message", (ev) => onFrame(ev.data));
  }

  window.WebSocket = new Proxy(NativeWebSocket, {
    construct(target, args, newTarget) {
      const ws = Reflect.construct(target, args, newTarget);
      try {
        const url = new URL(String(args[0]), location.href);
        if (url.hostname === STREAM_HOST && url.pathname === "/connect") tap(ws, url);
      } catch (e) {
        console.warn("[freight-reply] could not tap chat socket", e);
      }
      return ws;
    },
  });

  // The Stream SDK refreshes its token without reopening the socket, so follow its REST calls too.
  const xhrUrls = new WeakMap();
  const { open, setRequestHeader } = XMLHttpRequest.prototype;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    xhrUrls.set(this, String(url));
    return open.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (String(name).toLowerCase() === "authorization" && xhrUrls.get(this)?.startsWith(`https://${STREAM_HOST}/`)) {
      session.token = String(value);
    }
    return setRequestHeader.call(this, name, value);
  };

  const isConnected = () => session.socket?.readyState === NativeWebSocket.OPEN;

  async function send(replyRef, text) {
    if (!isConnected()) return { ok: false, error: "chat connection is not open" };
    if (replyRef?.type !== "messaging" || !/^[\w!-]+$/.test(replyRef?.id || "") || !text?.trim()) {
      return { ok: false, error: "invalid channel or empty text" };
    }
    const messageId = ID_PREFIX + crypto.randomUUID();
    try {
      await streamPost(`/channels/messaging/${encodeURIComponent(replyRef.id)}/message`, {
        message: { id: messageId, text },
      });
      return { ok: true };
    } catch (e) {
      // Without an HTTP status the request may still have reached the server.
      return { ok: false, uncertain: !e.status, error: e.message };
    }
  }

  window.addEventListener("message", async (ev) => {
    if (ev.source !== window || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.channel !== TO_BRIDGE) return;
    if (!session.socket) return;
    if (d.type === "ping") emit("result", null, { reqId: d.reqId, ok: isConnected() });
    if (d.type === "send") emit("result", null, { reqId: d.reqId, ...(await send(d.replyRef, d.text)) });
  });
})();
