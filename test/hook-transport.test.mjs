import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  NativeMessageDecoder,
  encodeNativeMessage
} from "../companion/native-framing.mjs";
import {
  claudeOtelConfigPath,
  createClaudeOtelConfig
} from "../companion/claude-otel-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("hook events travel through the local companion to native messaging", async (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-runtime-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-home-"));
  const otelConfig = createClaudeOtelConfig(await availablePort());
  fs.mkdirSync(path.dirname(claudeOtelConfigPath(home)), { recursive: true });
  fs.writeFileSync(
    claudeOtelConfigPath(home),
    `${JSON.stringify(otelConfig)}\n`,
    { mode: 0o600 }
  );
  const environment = {
    ...process.env,
    GO_ROT_HOME: home,
    GO_ROT_RUNTIME_DIR: runtime,
    GO_ROT_SOURCE_APP: "Terminal"
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
  assert.equal(
    messages.find((message) => message.type === "companion.ready")
      .claudeDecisionReceiver,
    true
  );
  assert.equal(fs.statSync(runtime).mode & 0o777, 0o700);
  assert.equal(
    fs.statSync(path.join(runtime, "companion.sock")).mode & 0o777,
    0o600
  );

  const hook = spawn(
    process.execPath,
    [
      path.join(root, "bin", "go-rot-hook.mjs"),
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
      path.join(root, "bin", "go-rot-hook.mjs"),
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
  assert.equal(resumed.event.type, "work.started");
  assert.equal("tool_response" in resumed.event, false);

  const continuationHook = spawn(
    process.execPath,
    [
      path.join(root, "bin", "go-rot-hook.mjs"),
      "--provider",
      "codex",
      "--surface",
      "cli"
    ],
    { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] }
  );
  continuationHook.stdin.end(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "goal-session-e2e",
      turn_id: "goal-turn-e2e",
      tool_input: { command: "must stay private" }
    })
  );
  await new Promise((resolve) => continuationHook.once("close", resolve));
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === "goal-session-e2e"
    )
  );
  const continuation = messages.find(
    (message) =>
      message.type === "lifecycle.event" &&
      message.event.sessionId === "goal-session-e2e"
  );
  assert.equal(continuation.event.type, "work.started");
  assert.equal(JSON.stringify(continuation).includes("must stay private"), false);

  host.stdin.write(encodeNativeMessage({ type: "activity.reset" }));
  await waitFor(() => {
    try {
      const state = JSON.parse(
        fs.readFileSync(path.join(runtime, "state.json"), "utf8")
      );
      return state.sessions.length === 0;
    } catch {
      return false;
    }
  });

  const permissionHook = spawn(
    process.execPath,
    [
      path.join(root, "bin", "go-rot-hook.mjs"),
      "--provider",
      "claude-code",
      "--surface",
      "cli"
    ],
    { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] }
  );
  const permissionClosed = new Promise((resolve) =>
    permissionHook.once("close", resolve)
  );
  permissionHook.stdin.end(
    JSON.stringify({
      hook_event_name: "PermissionRequest",
      session_id: "permission-session",
      tool_name: "Bash",
      tool_input: { command: "private command" }
    })
  );
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === "permission-session" &&
        message.event.type === "attention.required"
    )
  );
  const permissionExit = await permissionClosed;
  assert.equal(permissionExit, 0);
  assert.equal(JSON.stringify(messages).includes("private command"), false);
  assert.equal(
    fs.readFileSync(path.join(runtime, "state.json"), "utf8").includes(
      "private command"
    ),
    false
  );

  const response = await fetch(
    `http://${otelConfig.host}:${otelConfig.port}/v1/logs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otelConfig.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        claudeDecisionPayload("permission-session", "private command")
      )
    }
  );
  assert.equal(response.status, 200);
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === "permission-session" &&
        message.event.type === "work.resumed"
    )
  );
  const decisionResume = messages.find(
    (message) =>
      message.type === "lifecycle.event" &&
      message.event.sessionId === "permission-session" &&
      message.event.type === "work.resumed"
  );
  assert.deepEqual(decisionResume.event, {
    protocolVersion: 1,
    type: "work.resumed",
    agent: "claude-code",
    surface: "cli",
    sessionId: "permission-session",
    turnId: "unknown-turn",
    sourceApp: "iTerm",
    timestamp: Date.parse("2026-07-24T20:00:00.000Z")
  });
  assert.equal(JSON.stringify(messages).includes("private command"), false);
  assert.equal(JSON.stringify(messages).includes("private@example.com"), false);

  const rejectedResponse = await fetch(
    `http://${otelConfig.host}:${otelConfig.port}/v1/logs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otelConfig.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        claudeDecisionPayload(
          "rejected-permission-session",
          "another private command",
          "reject"
        )
      )
    }
  );
  assert.equal(rejectedResponse.status, 200);
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === "rejected-permission-session" &&
        message.event.type === "work.completed"
    )
  );
  assert.equal(
    JSON.stringify(messages).includes("another private command"),
    false
  );

  const staleFollowUpResponse = await fetch(
    `http://${otelConfig.host}:${otelConfig.port}/v1/logs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otelConfig.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        claudeUserPromptPayload(
          "rejected-permission-session",
          "older private prompt",
          "2"
        )
      )
    }
  );
  assert.equal(staleFollowUpResponse.status, 200);
  assert.equal(
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === "rejected-permission-session" &&
        message.event.type === "work.started"
    ),
    false
  );

  const followUpResponse = await fetch(
    `http://${otelConfig.host}:${otelConfig.port}/v1/logs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otelConfig.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        claudeUserPromptPayload(
          "rejected-permission-session",
          "private replacement instructions"
        )
      )
    }
  );
  assert.equal(followUpResponse.status, 200);
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === "rejected-permission-session" &&
        message.event.type === "work.started"
    )
  );
  assert.equal(
    JSON.stringify(messages).includes("private replacement instructions"),
    false
  );

  const hookReplacementSession = "hook-replacement-session";
  const hookRejectedResponse = await fetch(
    `http://${otelConfig.host}:${otelConfig.port}/v1/logs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otelConfig.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        claudeDecisionPayload(
          hookReplacementSession,
          "private rejected command",
          "reject",
          new Date(Date.now() - 1_000).toISOString()
        )
      )
    }
  );
  assert.equal(hookRejectedResponse.status, 200);
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === hookReplacementSession &&
        message.event.type === "work.completed"
    )
  );

  await sendClaudeHook(environment, {
    hook_event_name: "UserPromptSubmit",
    session_id: hookReplacementSession,
    prompt: "private inline replacement"
  });
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === hookReplacementSession &&
        message.event.type === "work.started"
    )
  );

  const promptAfterHookResponse = await fetch(
    `http://${otelConfig.host}:${otelConfig.port}/v1/logs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otelConfig.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        claudeUserPromptPayload(
          hookReplacementSession,
          "private inline replacement",
          "4"
        )
      )
    }
  );
  assert.equal(promptAfterHookResponse.status, 200);
  assert.equal(
    messages.filter(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === hookReplacementSession &&
        message.event.type === "work.started"
    ).length,
    1
  );

  const delayedDecisionSession = "delayed-decision-session";
  await sendClaudeHook(environment, {
    hook_event_name: "UserPromptSubmit",
    session_id: delayedDecisionSession,
    prompt: "private replacement that beat the exporter"
  });
  await waitFor(() =>
    messages.some(
      (message) =>
        message.type === "lifecycle.event" &&
        message.event.sessionId === delayedDecisionSession &&
        message.event.type === "work.started"
    )
  );

  const delayedRejectionResponse = await fetch(
    `http://${otelConfig.host}:${otelConfig.port}/v1/logs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otelConfig.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        claudeDecisionPayload(
          delayedDecisionSession,
          "private delayed command",
          "reject",
          new Date(Date.now() - 1_000).toISOString()
        )
      )
    }
  );
  assert.equal(delayedRejectionResponse.status, 200);
  await waitFor(
    () =>
      messages.filter(
        (message) =>
          message.type === "lifecycle.event" &&
          message.event.sessionId === delayedDecisionSession
      ).length === 3
  );
  assert.deepEqual(
    messages
      .filter(
        (message) =>
          message.type === "lifecycle.event" &&
          message.event.sessionId === delayedDecisionSession
      )
      .map((message) => message.event.type),
    ["work.started", "work.completed", "work.started"]
  );

  const apiReplacementSession = "api-replacement-session";
  const apiReplacementResponse = await fetch(
    `http://${otelConfig.host}:${otelConfig.port}/v1/logs`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${otelConfig.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(
        claudeReplacementBatchPayload(
          apiReplacementSession,
          "private replacement request"
        )
      )
    }
  );
  assert.equal(apiReplacementResponse.status, 200);
  await waitFor(
    () =>
      messages.filter(
        (message) =>
          message.type === "lifecycle.event" &&
          message.event.sessionId === apiReplacementSession
      ).length === 2
  );
  assert.deepEqual(
    messages
      .filter(
        (message) =>
          message.type === "lifecycle.event" &&
          message.event.sessionId === apiReplacementSession
      )
      .map((message) => message.event.type),
    ["work.completed", "work.started"]
  );
  assert.equal(JSON.stringify(messages).includes("private inline replacement"), false);
  assert.equal(
    JSON.stringify(messages).includes("private replacement that beat the exporter"),
    false
  );
  const diagnosticState = JSON.parse(
    fs.readFileSync(path.join(runtime, "state.json"), "utf8")
  );
  assert.ok(
    diagnosticState.recentLifecycle.some(
      (event) =>
        event.source === "decision" && event.type === "work.completed"
    )
  );
  assert.ok(
    diagnosticState.recentLifecycle.some(
      (event) => event.source === "replay" && event.type === "work.started"
    )
  );
  assert.ok(
    diagnosticState.recentLifecycle.some(
      (event) =>
        event.source === "monitoring" &&
        event.type === "otel.tool_decision" &&
        event.sequence === "3" &&
        /^[a-f0-9]{12}$/.test(event.prompt)
    )
  );
  assert.equal(JSON.stringify(diagnosticState).includes("private"), false);
});

test("the self-contained Codex plugin hook uses the same private transport", async (t) => {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-plugin-"));
  const environment = {
    ...process.env,
    GO_ROT_RUNTIME_DIR: runtime,
    GO_ROT_SOURCE_APP: "Codex"
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
    path.join(root, "integrations", "go-rot", "scripts", "run-hook"),
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
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-missing-"));
  const startedAt = performance.now();
  const hook = spawn(
    process.execPath,
    [
      path.join(root, "bin", "go-rot-hook.mjs"),
      "--provider",
      "claude-code",
      "--surface",
      "cli"
    ],
    {
      cwd: root,
      env: { ...process.env, GO_ROT_RUNTIME_DIR: runtime },
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

function claudeDecisionPayload(
  sessionId,
  privateCommand,
  decision = "accept",
  timestamp = "2026-07-24T20:00:00.000Z"
) {
  const attribute = (key, value) => ({
    key,
    value: { stringValue: value }
  });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attribute("service.name", "claude-code"),
            attribute("terminal.type", "iTerm.app"),
            attribute("user.email", "private@example.com")
          ]
        },
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  attribute("event.name", "tool_decision"),
                  attribute("event.timestamp", timestamp),
                  attribute("event.sequence", "3"),
                  attribute("session.id", sessionId),
                  attribute("prompt.id", `prompt-${sessionId}`),
                  attribute("tool_use_id", "toolu_transport"),
                  attribute("decision", decision),
                  attribute(
                    "source",
                    decision === "accept" ? "user_temporary" : "user_reject"
                  ),
                  attribute(
                    "tool_parameters",
                    JSON.stringify({ full_command: privateCommand })
                  )
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

function claudeReplacementBatchPayload(sessionId, privateRequest) {
  const payload = claudeDecisionPayload(
    sessionId,
    "private rejected command",
    "reject"
  );
  const attribute = (key, value) => ({
    key,
    value: { stringValue: value }
  });
  payload.resourceLogs[0].scopeLogs[0].logRecords.push({
    attributes: [
      attribute("event.name", "api_request"),
      attribute("event.timestamp", "2026-07-24T20:00:01.000Z"),
      attribute("event.sequence", "4"),
      attribute("session.id", sessionId),
      attribute("prompt.id", `prompt-${sessionId}`),
      attribute("query_source", "repl_main_thread"),
      attribute("request_body", privateRequest)
    ]
  });
  return payload;
}

async function sendClaudeHook(environment, input) {
  const hook = spawn(
    process.execPath,
    [
      path.join(root, "bin", "go-rot-hook.mjs"),
      "--provider",
      "claude-code",
      "--surface",
      "cli"
    ],
    { cwd: root, env: environment, stdio: ["pipe", "pipe", "pipe"] }
  );
  hook.stdin.end(JSON.stringify(input));
  const code = await new Promise((resolve) => hook.once("close", resolve));
  assert.equal(code, 0);
}

function claudeUserPromptPayload(sessionId, privatePrompt, sequence = "4") {
  const attribute = (key, value) => ({
    key,
    value: { stringValue: value }
  });
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attribute("service.name", "claude-code"),
            attribute("terminal.type", "iTerm.app"),
            attribute("user.email", "private@example.com")
          ]
        },
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  attribute("event.name", "user_prompt"),
                  attribute("event.timestamp", "2026-07-24T20:00:01.000Z"),
                  attribute("event.sequence", sequence),
                  attribute("session.id", sessionId),
                  attribute("prompt", privatePrompt)
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

async function availablePort() {
  const net = await import("node:net");
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (Number.isInteger(port)) resolve(port);
        else reject(new Error("No transport test port was allocated."));
      });
    });
  });
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}
