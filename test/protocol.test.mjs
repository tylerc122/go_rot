import test from "node:test";
import assert from "node:assert/strict";
import {
  detectSourceApp,
  detectSurface,
  lifecycleEventFromHook,
  normalizeLifecycleEvent
} from "../companion/protocol.mjs";

test("maps shared provider hooks into normalized lifecycle events", () => {
  const base = {
    agent: "codex",
    surface: "cli",
    sourceApp: "iTerm"
  };
  const started = lifecycleEventFromHook(
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-1",
      prompt: "must not be copied"
    },
    base
  );
  assert.deepEqual(
    {
      type: started.type,
      agent: started.agent,
      surface: started.surface,
      sourceApp: started.sourceApp,
      sessionId: started.sessionId,
      turnId: started.turnId
    },
    {
      type: "work.started",
      agent: "codex",
      surface: "cli",
      sourceApp: "iTerm",
      sessionId: "session-1",
      turnId: "turn-1"
    }
  );
  assert.equal("prompt" in started, false);
});

test("maps Claude continuation, permission, notification, stop, and session end hooks", () => {
  const options = {
    agent: "claude-code",
    surface: "desktop",
    sourceApp: "Claude"
  };
  const fixture = (hook_event_name, extra = {}) =>
    lifecycleEventFromHook(
      {
        hook_event_name,
        session_id: "s",
        turn_id: "t",
        ...extra
      },
      options
    );

  assert.equal(fixture("PermissionRequest").reason, "permission");
  assert.equal(fixture("PreToolUse").type, "work.started");
  assert.equal(fixture("PostToolUse").type, "work.started");
  assert.equal(
    fixture("Notification", { notification_type: "idle_prompt" }).reason,
    "question"
  );
  assert.equal(fixture("Stop").type, "work.completed");
  assert.equal(fixture("SessionEnd").type, "session.ended");
  assert.equal(fixture("UnknownHook"), null);
});

test("maps Codex post-tool activity to the same fallback start", () => {
  const event = lifecycleEventFromHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "goal-session",
      turn_id: "goal-turn"
    },
    {
      agent: "codex",
      surface: "desktop",
      sourceApp: "Codex"
    }
  );

  assert.equal(event.type, "work.started");
});

test("rejects unknown protocol values", () => {
  assert.throws(
    () =>
      normalizeLifecycleEvent({
        type: "work.started",
        agent: "unknown",
        surface: "cli"
      }),
    /Unsupported agent/
  );
});

test("detects terminal and desktop sources without conversation content", () => {
  assert.equal(detectSurface("codex", { TERM_PROGRAM: "iTerm.app" }), "cli");
  assert.equal(
    detectSurface(
      "codex",
      { TERM_PROGRAM: "iTerm.app" },
      { client_id: "codex_app" }
    ),
    "desktop"
  );
  assert.equal(detectSurface("codex", {}, { client_id: "codex-cli" }), "cli");
  assert.equal(detectSourceApp("codex", "cli", { TERM_PROGRAM: "iTerm.app" }), "iTerm");
  assert.equal(detectSurface("claude-code", {}), "desktop");
  assert.equal(detectSourceApp("claude-code", "desktop", {}), "Claude");
});
