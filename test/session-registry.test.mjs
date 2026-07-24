import test from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../extension/session-registry.mjs";

test("keeps one active session and never lets background completion steal it", () => {
  const registry = new SessionRegistry();
  const first = { state: "waiting", source: "Codex" };
  const second = { state: "waiting", source: "Claude" };

  assert.equal(registry.start("first", first).kind, "active");
  assert.equal(registry.start("second", second).kind, "background");
  assert.equal(second.state, "background");

  const terminal = registry.terminal("second");
  assert.equal(terminal.kind, "background");
  assert.equal(registry.active(), first);
  assert.equal(registry.readyCount(), 1);
});

test("deduplicates starts and releases only the matching active session", () => {
  const registry = new SessionRegistry();
  const session = { state: "waiting" };

  assert.equal(registry.start("turn", session).kind, "active");
  assert.equal(registry.start("turn", {}).kind, "duplicate");
  assert.equal(registry.terminal("turn").kind, "active");

  registry.complete("turn");
  assert.equal(registry.active(), null);
  assert.equal(registry.terminal("turn").kind, "missing");
});

test("cleans an entire provider session even when SessionEnd has no turn id", () => {
  const registry = new SessionRegistry();
  const active = {
    state: "waiting",
    event: { agent: "codex", sessionId: "session-1" }
  };
  const background = {
    state: "waiting",
    event: { agent: "codex", sessionId: "session-1" }
  };

  registry.start("codex:session-1:turn-1", active);
  registry.start("codex:session-1:turn-2", background);

  assert.equal(registry.endSession("codex", "session-1"), active);
  registry.complete("codex:session-1:turn-1");
  assert.equal(registry.active(), null);
  assert.equal(registry.terminal("codex:session-1:turn-2").kind, "missing");
});
