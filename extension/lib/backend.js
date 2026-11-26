// Client for the web app that holds the reply rules. Contract: docs/API.md

// The server's default model may need to wake its machine first.
const TIMEOUT_MS = 90000;

export class PaymentRequiredError extends Error {
  constructor(paymentUrl) {
    super("the server says payment is required");
    this.name = "PaymentRequiredError";
    this.paymentUrl = paymentUrl;
  }
}

export function normalizeBaseUrl(raw) {
  const url = new URL(raw);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("server address must use https (http is allowed for localhost only)");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

const httpsOrNull = (value) => {
  try {
    return new URL(value).protocol === "https:" ? new URL(value).href : null;
  } catch {
    return null;
  }
};

async function call(backend, path, init, fetchImpl) {
  if (!backend.apiKey) throw new Error("no access key: add it in the extension settings");
  const res = await fetchImpl(`${normalizeBaseUrl(backend.baseUrl)}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${backend.apiKey}` },
    credentials: "omit",
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 402) throw new PaymentRequiredError(httpsOrNull(body.paymentUrl));
  if (res.status === 401) throw new Error("the server rejected the access key");
  if (!res.ok) {
    throw new Error(typeof body.detail === "string" ? body.detail : `server returned HTTP ${res.status}`);
  }
  return body;
}

export const checkConnection = (backend, fetchImpl = fetch) =>
  call(backend, "/v1/me", { method: "GET" }, fetchImpl);

export async function requestDecision(backend, msg, isFirst, fetchImpl = fetch) {
  const body = await call(
    backend,
    "/v1/decide",
    {
      method: "POST",
      // Only what is needed to decide on a reply: no ids, tokens or account data.
      body: JSON.stringify({
        platform: msg.platform,
        text: msg.text,
        senderName: msg.senderName || "",
        senderFirstName: msg.senderFirstName || "",
        isFirst,
        history: (msg.history || []).slice(-10).filter((h) => h.text),
        context: {
          loadingCity: msg.context?.loadingCity || "",
          unloadingCity: msg.context?.unloadingCity || "",
          senderCompany: msg.context?.senderCompany || "",
        },
      }),
    },
    fetchImpl,
  );
  if (!["reply", "ignore", "none"].includes(body.action)) throw new Error("unexpected answer from the server");
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 2500) : "";
  return {
    action: body.action === "reply" && !text ? "none" : body.action,
    text,
    // Anything but a literal true means "ask the user first".
    autoSend: body.autoSend === true,
    source: String(body.source || "server").slice(0, 150),
    note: String(body.note || "").slice(0, 200),
  };
}
