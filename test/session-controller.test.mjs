import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  clampSettings,
  isTerminalEvent,
  nextFeedProvider,
  sessionEligibility,
  sessionKey
} from "../extension/session-controller.mjs";

test("clamps untrusted settings and falls back to a known provider", () => {
  assert.deepEqual(
    clampSettings({
      enabled: false,
      provider: "unknown",
      delayMs: -20,
      windowWidth: 10_000,
      windowHeight: "large"
    }),
    {
      enabled: false,
      agents: DEFAULT_SETTINGS.agents,
      pausedUntil: DEFAULT_SETTINGS.pausedUntil,
      provider: "youtube",
      shuffleFeeds: DEFAULT_SETTINGS.shuffleFeeds,
      enabledProviders: DEFAULT_SETTINGS.enabledProviders,
      lastShuffledProvider: DEFAULT_SETTINGS.lastShuffledProvider,
      pauseMedia: DEFAULT_SETTINGS.pauseMedia,
      finishCurrentClip: DEFAULT_SETTINGS.finishCurrentClip,
      feedTested: DEFAULT_SETTINGS.feedTested,
      observedAgents: DEFAULT_SETTINGS.observedAgents,
      delayMs: 0,
      windowWidth: 900,
      windowHeight: DEFAULT_SETTINGS.windowHeight,
      windowLeft: null,
      windowTop: null,
      windowDisplayId: null
    }
  );
});

test("rotates predictably through enabled feeds", () => {
  const settings = clampSettings({
    shuffleFeeds: true,
    enabledProviders: ["youtube", "instagram"],
    lastShuffledProvider: "youtube"
  });
  assert.equal(nextFeedProvider(settings), "instagram");
  assert.equal(
    nextFeedProvider({ ...settings, lastShuffledProvider: "instagram" }),
    "youtube"
  );
  assert.equal(
    nextFeedProvider({ ...settings, shuffleFeeds: false, provider: "tiktok" }),
    "tiktok"
  );
});

test("supports global pause and independent agent toggles", () => {
  const settings = clampSettings({
    agents: { codex: false, "claude-code": true },
    pausedUntil: 5000
  });

  assert.equal(
    sessionEligibility(settings, { agent: "claude-code" }, 4000),
    "paused"
  );
  assert.equal(
    sessionEligibility(settings, { agent: "codex" }, 6000),
    "agent-disabled"
  );
  assert.equal(
    sessionEligibility(settings, { agent: "claude-code" }, 6000),
    "eligible"
  );
});

test("identifies terminal events and stable session keys", () => {
  const event = {
    agent: "codex",
    sessionId: "session",
    turnId: "turn"
  };
  assert.equal(sessionKey(event), "codex:session:turn");
  assert.equal(isTerminalEvent({ type: "attention.required" }), false);
  assert.equal(isTerminalEvent({ type: "work.completed" }), true);
  assert.equal(isTerminalEvent({ type: "work.started" }), false);
});
