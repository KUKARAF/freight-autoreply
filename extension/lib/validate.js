// Messages come from page context, so shape and size are checked before the engine sees them.
export const PLATFORM_BY_HOST = { "platform.trans.eu": "transeu", "my.timocom.com": "timocom" };

const str = (v, max = 500) => (typeof v === "string" ? v.slice(0, max) : "");
const id = (v) => (typeof v === "string" && v.length > 0 && v.length <= 300 ? v : null);

const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => obj?.[k] != null).map((k) => [k, str(String(obj[k]), 300)]));

export function sanitizeEvent(type, p, platform) {
  if (!p || p.platform !== platform || !id(p.peerId)) return null;
  if (type === "own") return { platform, peerId: p.peerId, id: str(p.id) };
  if (!id(p.id) || !id(p.conversationId) || !str(p.text).trim()) return null;

  let replyRef;
  if (platform === "transeu") {
    replyRef = { to: str(p.replyRef?.to, 200) };
    if (p.replyRef?.v1) replyRef.v1 = pick(p.replyRef.v1, ["domainId", "ownerId", "itemId"]);
    if (p.replyRef?.v2) replyRef.v2 = pick(p.replyRef.v2, ["domainId", "contextId"]);
  } else {
    replyRef = pick(p.replyRef, ["type", "id"]);
  }

  return {
    platform,
    id: p.id,
    peerId: p.peerId,
    conversationId: p.conversationId,
    senderName: str(p.senderName, 200),
    senderFirstName: str(p.senderFirstName, 100),
    text: str(p.text, 4000),
    timestamp: Number.isFinite(p.timestamp) ? p.timestamp : undefined,
    detailsUnavailable: p.detailsUnavailable === true,
    history: (Array.isArray(p.history) ? p.history : [])
      .slice(-12)
      .map((h) => ({ role: h?.role === "me" ? "me" : "them", text: str(h?.text, 2000) })),
    context: {
      ...pick(p.context, ["contextId", "contextType", "loadingCity", "unloadingCity", "senderCompany"]),
      aiNegotiator: p.context?.aiNegotiator === true,
    },
    replyRef,
  };
}
