import test from "node:test";
import assert from "node:assert/strict";
import {
  pauseDeadline,
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

test("presents disabled, paused, active, disconnected, and ready states", () => {
  assert.equal(
    statusPresentation({ settings: { ...readySettings, enabled: false } }).title,
    "FirstTok is off"
  );
  assert.equal(
    statusPresentation(
      { settings: { ...readySettings, pausedUntil: 2000 } },
      1000
    ).title,
    "Paused"
  );
  assert.equal(
    statusPresentation({
      settings: readySettings,
      activeSession: { agent: "claude-code", state: "active" }
    }).title,
    "Claude Code is working"
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
    "Ready"
  );
});
