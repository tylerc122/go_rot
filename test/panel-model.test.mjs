import test from "node:test";
import assert from "node:assert/strict";
import {
  pauseDeadline,
  setupPresentation,
  statusPresentation
} from "../extension/panel-model.mjs";

const readySettings = {
  enabled: true,
  pausedUntil: 0
};

test("computes fixed and next-day pause deadlines", () => {
  const now = new Date("2026-07-24T10:15:00-05:00");
  assert.equal(pauseDeadline("15m", now), now.getTime() + 900_000);
  assert.equal(pauseDeadline("1h", now), now.getTime() + 3_600_000);

  const tomorrow = new Date(pauseDeadline("tomorrow", now));
  assert.equal(tomorrow.getDate(), 25);
  assert.equal(tomorrow.getHours(), 0);
  assert.equal(tomorrow.getMinutes(), 0);
});

test("presents setup progress from real readiness evidence", () => {
  const waiting = setupPresentation({
    connectionState: "connected",
    settings: { feedTested: false, observedAgents: {} }
  });
  assert.equal(waiting.complete, false);
  assert.equal(waiting.completedCount, 1);
  assert.equal(waiting.items.find((item) => item.id === "feed").complete, false);

  const complete = setupPresentation({
    connectionState: "connected",
    settings: {
      feedTested: true,
      observedAgents: { codex: 100, "claude-code": 0 }
    }
  });
  assert.equal(complete.complete, true);
  assert.equal(
    complete.items.find((item) => item.id === "agent").detail,
    "Codex detected"
  );
});

test("presents disabled, paused, active, disconnected, and ready states", () => {
  assert.equal(
    statusPresentation({ settings: { ...readySettings, enabled: false } }).title,
    "Go Rot is off"
  );
  assert.equal(
    statusPresentation(
      { settings: { ...readySettings, pausedUntil: 2000 } },
      1000
    ).title,
    "Rot privileges suspended."
  );
  assert.equal(
    statusPresentation({
      settings: readySettings,
      activeSession: { agent: "claude-code", state: "active" }
    }).title,
    "Agent has it."
  );
  assert.deepEqual(
    statusPresentation({
      settings: readySettings,
      feedSession: { agent: "codex", state: "finishing" }
    }),
    {
      tone: "ready",
      title: "Agent cooked.",
      detail: "Finish this clip or head back now."
    }
  );
  assert.equal(
    statusPresentation({
      settings: readySettings,
      activity: { working: 2, attention: 1, ready: 1 },
      feedSession: { agent: "codex", state: "parked" }
    }).title,
    "Codex needs you"
  );
  assert.equal(
    statusPresentation({
      settings: readySettings,
      connectionState: "disconnected",
      lastError: "Missing host."
    }).title,
    "Companion unavailable"
  );
  assert.equal(
    statusPresentation({
      settings: readySettings,
      connectionState: "connected"
    }).title,
    "Ready to rot."
  );
});
