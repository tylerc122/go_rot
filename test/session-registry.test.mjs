import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../extension/session-registry.mjs";

function task(agent, sessionId, turnId) {
  return {
    event: { agent, sessionId, turnId },
    state: "working"
  };
}

test("tracks concurrent work, attention, and ready turns independently", () => {
  const registry = new SessionRegistry();
  const first = task("codex", "s1", "t1");
  const second = task("claude-code", "s2", "t2");

  assert.equal(registry.start("first", first).kind, "started");
  assert.equal(registry.start("second", second).kind, "started");
  assert.deepEqual(registry.counts(), {
    working: 2,
    attention: 0,
    ready: 0
  });

  registry.requireAttention("first", {
    ...first.event,
    reason: "permission"
  });
  registry.complete("second", second.event);
  assert.deepEqual(registry.counts(), {
    working: 0,
    attention: 1,
    ready: 1
  });
  assert.equal(registry.latestAttention(), first);
});

test("resumes an exact permission turn and deduplicates active work", () => {
  const registry = new SessionRegistry();
  const active = task("codex", "session", "turn");

  assert.equal(registry.start("turn", active).kind, "started");
  assert.equal(registry.start("turn", task("codex", "session", "turn")).kind, "duplicate");
  registry.requireAttention("turn", {
    ...active.event,
    reason: "permission"
  });
  assert.equal(registry.resume("turn", active.event).kind, "resumed");
  assert.deepEqual(registry.counts(), {
    working: 1,
    attention: 0,
    ready: 0
  });
});

test("late resume signals cannot resurrect a ready turn", () => {
  const registry = new SessionRegistry();
  const finished = task("codex", "session", "turn");
  registry.start("turn", finished);
  registry.complete("turn", finished.event);

  assert.equal(registry.resume("turn", finished.event).kind, "unchanged");
  assert.deepEqual(registry.counts(), {
    working: 0,
    attention: 0,
    ready: 1
  });
});

test("a new start signal can restart work after the prior turn completed", () => {
  const registry = new SessionRegistry();
  const first = task("codex", "goal-session", "turn-1");
  registry.start("codex:goal-session:turn-1", first);
  registry.complete("codex:goal-session:turn-1", first.event);
  registry.clearReady();

  const continuation = task("codex", "goal-session", "turn-2");
  assert.equal(
    registry.start("codex:goal-session:turn-2", continuation).kind,
    "started"
  );
  assert.deepEqual(registry.counts(), {
    working: 1,
    attention: 0,
    ready: 0
  });
});

test("completion resolves the sole pending task when its turn id changes", () => {
  const registry = new SessionRegistry();
  const pending = task("codex", "session", "submitted-turn");
  registry.start("codex:session:submitted-turn", pending);
  registry.requireAttention("codex:session:submitted-turn", {
    ...pending.event,
    reason: "permission"
  });

  const result = registry.complete("codex:session:unknown-turn", {
    agent: "codex",
    sessionId: "session",
    turnId: "unknown-turn"
  });

  assert.equal(result.kind, "completed");
  assert.equal(result.task, pending);
  assert.deepEqual(registry.counts(), {
    working: 0,
    attention: 0,
    ready: 1
  });
  assert.equal(registry.pendingCount(), 0);
});

test("completion stays conservative when a provider session has multiple pending tasks", () => {
  const registry = new SessionRegistry();
  registry.start(
    "codex:session:turn-1",
    task("codex", "session", "turn-1")
  );
  registry.start(
    "codex:session:turn-2",
    task("codex", "session", "turn-2")
  );

  const result = registry.complete("codex:session:unknown-turn", {
    agent: "codex",
    sessionId: "session",
    turnId: "unknown-turn"
  });

  assert.equal(result.kind, "recovered");
  assert.deepEqual(registry.counts(), {
    working: 2,
    attention: 0,
    ready: 1
  });
  assert.equal(registry.pendingCount(), 2);
});

test("a new user turn resolves an older question in the same provider session", () => {
  const registry = new SessionRegistry();
  const question = task("claude-code", "session", "turn-1");
  registry.start("turn-1", question);
  registry.requireAttention("turn-1", {
    ...question.event,
    reason: "question"
  });

  const answer = task("claude-code", "session", "turn-2");
  const result = registry.start("turn-2", answer);
  assert.equal(result.kind, "resumed");
  assert.equal(result.resumed.length, 1);
  assert.deepEqual(registry.counts(), {
    working: 1,
    attention: 0,
    ready: 0
  });
});

test("an unmatched idle question cannot create blocking activity", () => {
  const registry = new SessionRegistry();
  const result = registry.requireAttention(
    "claude-code:finished-session:unknown-turn",
    {
      agent: "claude-code",
      sessionId: "finished-session",
      turnId: "unknown-turn",
      reason: "question"
    },
    { recover: false }
  );

  assert.equal(result.kind, "missing");
  assert.equal(result.task, null);
  assert.deepEqual(registry.counts(), {
    working: 0,
    attention: 0,
    ready: 0
  });
});

test("an idle question with a changed turn id attaches to active work", () => {
  const registry = new SessionRegistry();
  const active = task("claude-code", "active-session", "submitted-turn");
  registry.start("claude-code:active-session:submitted-turn", active);

  const result = registry.requireAttention(
    "claude-code:active-session:unknown-turn",
    {
      agent: "claude-code",
      sessionId: "active-session",
      turnId: "unknown-turn",
      reason: "question"
    },
    { recover: false }
  );

  assert.equal(result.kind, "attention");
  assert.equal(result.task, active);
  assert.deepEqual(registry.counts(), {
    working: 0,
    attention: 1,
    ready: 0
  });
});

test("cleans an entire provider session even when SessionEnd has no turn id", () => {
  const registry = new SessionRegistry();
  registry.start(
    "codex:session-1:turn-1",
    task("codex", "session-1", "turn-1")
  );
  registry.start(
    "codex:session-1:turn-2",
    task("codex", "session-1", "turn-2")
  );

  const removed = registry.endSession("codex", "session-1");
  assert.equal(removed.length, 2);
  assert.equal(registry.pendingCount(), 0);
});

test("clears every task for explicit stale-activity recovery", () => {
  const registry = new SessionRegistry();
  registry.start("working", task("codex", "session-1", "turn-1"));
  registry.requireAttention("attention", {
    ...task("claude-code", "session-2", "turn-2").event,
    reason: "permission"
  });

  const removed = registry.clearAll();
  assert.equal(removed.length, 2);
  assert.deepEqual(registry.counts(), {
    working: 0,
    attention: 0,
    ready: 0
  });
});
