export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  // false = every reply waits for approval in the popup.
  autoSend: false,
  platforms: { transeu: true, timocom: true },
  limits: {
    delayMinSec: 5,
    delayMaxSec: 20,
    cooldownSec: 60,
    maxPerConversationPerDay: 3,
    maxPerHour: 30,
    // After the user writes by hand, leave that contact alone this long.
    humanQuietMin: 60,
  },
  // The web app holds the reply rules and the AI prompt.
  backend: { baseUrl: "https://freight.osmosis.page", apiKey: "" },
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// Stored values win; anything missing or of the wrong type falls back to the default.
export function withDefaults(stored, defaults = DEFAULT_SETTINGS) {
  if (Array.isArray(defaults)) return structuredClone(Array.isArray(stored) ? stored : defaults);
  if (isObject(defaults)) {
    return Object.fromEntries(
      Object.entries(defaults).map(([k, d]) => [k, withDefaults(isObject(stored) ? stored[k] : undefined, d)]),
    );
  }
  if (typeof stored !== typeof defaults) return defaults;
  if (typeof defaults === "number") return Number.isFinite(stored) && stored >= 0 ? stored : defaults;
  return stored;
}
