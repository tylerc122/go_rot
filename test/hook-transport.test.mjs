import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { NativeMessageDecoder } from "../companion/native-framing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("hook events travel through the local companion to native messaging", async (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-runtime-"));
  const environment = {
    ...process.env,
    FIRSTTOK_RUNTIME_DIR: runtime,
    FIRSTTOK_SOURCE_APP: "Terminal"
  };
  const host = spawn(process.execPath, [path.join(root, "companion", "native-host.mjs")], {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"]
  });
  t.after(() => host.kill("SIGTERM"));

  const decoder = new NativeMessageDecoder();
  const messages = [];
  host.stdout.on("data", (chunk) => messages.push(...decoder.push(chunk)));
  await waitFor(() => messages.some((message) => message.type === "companion.ready"));
  assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(path.join(runtime, "companion.sock")).mode & 0o777,
    0o600
  );

  const hook = spawn(
    process.execPath,
    [
      path.join(root, "bin", "firsttok-hook.mjs"),
      "--provider",
      "codex",
      "--surface",
      "cli"
    ],
    { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] }
  );
  hook.stdin.end(
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-e2e",
      turn_id: "turn-e2e",
      prompt: "private prompt"
    })
  );
  await new Promise((resolve) => hook.once("close", resolve));
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === "session-e2e"
    )
  );

  const lifecycle = messages.find(
    (message) =>
      message.type === "lifecycle.event" &&
      message.event.sessionId === "session-e2e"
  );
  assert.equal(lifecycle.event.type, "work.started");
  assert.equal(lifecycle.event.sourceApp, "Terminal");
  assert.equal("prompt" in lifecycle.event, false);

  const resumeHook = spawn(
    process.execPath,
    [
      path.join(root, "bin", "firsttok-hook.mjs"),
      "--provider",
      "codex",
      "--surface",
      "cli"
    ],
    { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] }
  );
  resumeHook.stdin.end(
    JSON.stringify({
      hook_event_name: "PostToolUse",
      session_id: "session-e2e",
      turn_id: "turn-e2e",
      tool_response: "must stay private"
    })
  );
  await new Promise((resolve) => resumeHook.once("close", resolve));
  await waitFor(
    () =>
      messages.filter(
        (message) =>
          message.type === "lifecycle.event" &&
          message.event.sessionId === "session-e2e"
      ).length === 2
  );
  const resumed = messages.filter(
    (message) =>
      message.type === "lifecycle.event" &&
      message.event.sessionId === "session-e2e"
  )[1];
  assert.equal(resumed.event.type, "work.resumed");
  assert.equal("tool_response" in resumed.event, false);
});

test("the self-contained Codex plugin hook uses the same private transport", async (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-plugin-"));
  const environment = {
    ...process.env,
    FIRSTTOK_RUNTIME_DIR: runtime,
    FIRSTTOK_SOURCE_APP: "Codex"
  };
  const host = spawn(
    process.execPath,
    [path.join(root, "companion", "native-host.mjs")],
    {
      cwd: root,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  t.after(() => host.kill("SIGTERM"));

  const decoder = new NativeMessageDecoder();
  const messages = [];
  host.stdout.on("data", (chunk) => messages.push(...decoder.push(chunk)));
  await waitFor(() => messages.some((message) => message.type === "companion.ready"));

  const hook = spawn(
    path.join(root, "integrations", "firsttok", "scripts", "run-hook"),
    [],
    {
      cwd: root,
      env: {
        ...environment,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
      },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  hook.stdin.end(
    JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "plugin-session",
      turn_id: "plugin-turn",
      tool_input: { command: "must stay private" }
    })
  );
  await new Promise((resolve) => hook.once("close", resolve));
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === "plugin-session"
    )
  );

  const lifecycle = messages.find(
    (message) =>
      message.type === "lifecycle.event" &&
      message.event.sessionId === "plugin-session"
  );
  assert.equal(lifecycle.event.type, "attention.required");
  assert.equal(lifecycle.event.reason, "permission");
  assert.equal(lifecycle.event.sourceApp, "Codex");
  assert.equal("tool_input" in lifecycle.event, false);
});

test("hook failure stays silent, successful, and bounded without a companion", async () => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-missing-"));
  const startedAt = performance.now();
  const hook = spawn(
    process.execPath,
    [
      path.join(root, "bin", "firsttok-hook.mjs"),
      "--provider",
      "claude-code",
      "--surface",
      "cli"
    ],
    {
      cwd: root,
      env: { ...process.env, FIRSTTOK_RUNTIME_DIR: runtime },
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  let stderr = "";
  hook.stderr.setEncoding("utf8");
  hook.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  hook.stdin.end(
    JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "no-companion"
    })
  );
  const code = await new Promise((resolve) => hook.once("close", resolve));
  const elapsed = performance.now() - startedAt;

  assert.equal(code, 0);
  assert.equal(stderr, "");
  assert.ok(elapsed < 250, `hook took ${elapsed.toFixed(1)} ms`);
});

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}
