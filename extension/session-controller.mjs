export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  agents: Object.freeze({
    codex: true,
    "claude-code": true
  }),
  pausedUntil: 0,
  provider: "youtube",
  delayMs: 2000,
  windowWidth: 480,
  windowHeight: 820
});

export const PROVIDERS = Object.freeze({
  youtube: {
    label: "YouTube Shorts",
    url: "https://www.youtube.com/shorts"
  },
  tiktok: {
    label: "TikTok",
    url: "https://www.tiktok.com/foryou"
  },
  instagram: {
    label: "Instagram Reels",
    url: "https://www.instagram.com/reels/"
  }
});

export function sessionKey(event) {
  return `${event.agent}:${event.sessionId}:${event.turnId}`;
}

export function isTerminalEvent(event) {
  return [
    "attention.required",
    "work.completed",
    "session.ended"
  ].includes(event.type);
}

export function sessionEligibility(settings, event, now = Date.now()) {
  if (!settings.enabled) return "disabled";
  if (settings.pausedUntil > now) return "paused";
  if (settings.agents[event.agent] === false) return "agent-disabled";
  return "eligible";
}

export function clampSettings(input = {}) {
  const provider = PROVIDERS[input.provider]
    ? input.provider
    : DEFAULT_SETTINGS.provider;
  const agents =
    input.agents && typeof input.agents === "object" ? input.agents : {};
  return {
    enabled:
      typeof input.enabled === "boolean"
        ? input.enabled
        : DEFAULT_SETTINGS.enabled,
    agents: {
      codex:
        typeof agents.codex === "boolean"
          ? agents.codex
          : DEFAULT_SETTINGS.agents.codex,
      "claude-code":
        typeof agents["claude-code"] === "boolean"
          ? agents["claude-code"]
          : DEFAULT_SETTINGS.agents["claude-code"]
    },
    pausedUntil: clampNumber(
      input.pausedUntil,
      0,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_SETTINGS.pausedUntil
    ),
    provider,
    delayMs: clampNumber(input.delayMs, 0, 15_000, DEFAULT_SETTINGS.delayMs),
    windowWidth: clampNumber(
      input.windowWidth,
      360,
      900,
      DEFAULT_SETTINGS.windowWidth
    ),
    windowHeight: clampNumber(
      input.windowHeight,
      540,
      1200,
      DEFAULT_SETTINGS.windowHeight
    )
  };
}

function clampNumber(value, minimum, maximum, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
