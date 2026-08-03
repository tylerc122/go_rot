export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  pausedUntil: 0,
  provider: "youtube",
  shuffleFeeds: false,
  enabledProviders: Object.freeze(["youtube", "tiktok", "instagram"]),
  lastShuffledProvider: null,
  pauseMedia: false,
  finishCurrentClip: false,
  feedTested: false,
  observedAgents: Object.freeze({
    codex: 0,
    "claude-code": 0
  }),
  delayMs: 2000,
  windowWidth: 480,
  windowHeight: 820,
  windowLeft: null,
  windowTop: null,
  windowDisplayId: null
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
  return ["work.completed", "session.ended"].includes(event.type);
}

export function sessionEligibility(settings, event, now = Date.now()) {
  if (!settings.enabled) return "disabled";
  if (settings.pausedUntil > now) return "paused";
  return "eligible";
}

export function nextFeedProvider(settings) {
  if (!settings.shuffleFeeds) return settings.provider;
  const enabled = settings.enabledProviders.filter((provider) => PROVIDERS[provider]);
  if (enabled.length === 0) return settings.provider;
  const currentIndex = enabled.indexOf(settings.lastShuffledProvider);
  return enabled[(currentIndex + 1) % enabled.length];
}

export function clampSettings(input = {}) {
  const provider = PROVIDERS[input.provider]
    ? input.provider
    : DEFAULT_SETTINGS.provider;
  const enabledProviders = Array.isArray(input.enabledProviders)
    ? [...new Set(input.enabledProviders)].filter((candidate) => PROVIDERS[candidate])
    : [...DEFAULT_SETTINGS.enabledProviders];
  if (enabledProviders.length === 0) enabledProviders.push(provider);
  const observedAgents =
    input.observedAgents && typeof input.observedAgents === "object"
      ? input.observedAgents
      : {};
  return {
    enabled:
      typeof input.enabled === "boolean"
        ? input.enabled
        : DEFAULT_SETTINGS.enabled,
    pausedUntil: clampNumber(
      input.pausedUntil,
      0,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_SETTINGS.pausedUntil
    ),
    provider,
    shuffleFeeds:
      typeof input.shuffleFeeds === "boolean"
        ? input.shuffleFeeds
        : DEFAULT_SETTINGS.shuffleFeeds,
    enabledProviders,
    lastShuffledProvider: PROVIDERS[input.lastShuffledProvider]
      ? input.lastShuffledProvider
      : DEFAULT_SETTINGS.lastShuffledProvider,
    pauseMedia:
      typeof input.pauseMedia === "boolean"
        ? input.pauseMedia
        : DEFAULT_SETTINGS.pauseMedia,
    finishCurrentClip:
      typeof input.finishCurrentClip === "boolean"
        ? input.finishCurrentClip
        : DEFAULT_SETTINGS.finishCurrentClip,
    feedTested:
      typeof input.feedTested === "boolean"
        ? input.feedTested
        : DEFAULT_SETTINGS.feedTested,
    observedAgents: {
      codex: clampNumber(
        observedAgents.codex,
        0,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_SETTINGS.observedAgents.codex
      ),
      "claude-code": clampNumber(
        observedAgents["claude-code"],
        0,
        Number.MAX_SAFE_INTEGER,
        DEFAULT_SETTINGS.observedAgents["claude-code"]
      )
    },
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
    ),
    windowLeft: clampNullableNumber(input.windowLeft),
    windowTop: clampNullableNumber(input.windowTop),
    windowDisplayId:
      typeof input.windowDisplayId === "string" && input.windowDisplayId
        ? input.windowDisplayId
        : DEFAULT_SETTINGS.windowDisplayId
  };
}

function clampNumber(value, minimum, maximum, fallback) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}

function clampNullableNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.round(value);
}
