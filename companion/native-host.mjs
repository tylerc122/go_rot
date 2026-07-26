#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  MAX_MESSAGE_BYTES,
  NATIVE_HOST_NAME,
  PROTOCOL_VERSION,
  runtimeDirectory,
  socketPath,
  statePath
} from "./constants.mjs";
import { readClaudeOtelConfig } from "./claude-otel-config.mjs";
import { startClaudeOtelReceiver } from "./claude-otel-receiver.mjs";
import { activateChromeFeed } from "./macos-activation.mjs";
import { NativeMessageDecoder, encodeNativeMessage } from "./native-framing.mjs";
import { normalizeLifecycleEvent } from "./protocol.mjs";

const execFileAsync = promisify(execFile);
const sessions = new Map();
const pendingClaudeRejections = new Map();
const latestClaudeStarts = new Map();
const recentLifecycle = [];
const nativeDecoder = new NativeMessageDecoder();
let extensionConnected = true;
let server;
let claudeOtelReceiver = null;

await prepareRuntime();
await startDecisionReceiver();
startNativeInput();
await startSocketServer();
sendNative({
  type: "companion.ready",
  protocolVersion: PROTOCOL_VERSION,
  host: NATIVE_HOST_NAME,
  socketPath: socketPath(),
  claudeDecisionReceiver: Boolean(claudeOtelReceiver)
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("exit", cleanupSocket);

function startNativeInput() {
  process.stdin.on("data", (chunk) => {
    let messages;
    try {
      messages = nativeDecoder.push(chunk);
    } catch (error) {
      sendNative({ type: "companion.error", message: error.message });
      return;
    }
    for (const message of messages) {
      handleExtensionMessage(message).catch((error) => {
        sendNative({ type: "companion.error", message: error.message });
      });
    }
  });

  process.stdin.on("end", () => {
    extensionConnected = false;
    shutdown();
  });
}

async function startSocketServer() {
  server = net.createServer((connection) => {
    let textBuffer = "";
    connection.setEncoding("utf8");
    connection.on("data", (chunk) => {
      textBuffer += chunk;
      if (Buffer.byteLength(textBuffer, "utf8") > MAX_MESSAGE_BYTES) {
        connection.end(
          `${JSON.stringify({ ok: false, error: "Lifecycle event is too large." })}\n`
        );
        return;
      }
      let newlineIndex;
      while ((newlineIndex = textBuffer.indexOf("\n")) !== -1) {
        const line = textBuffer.slice(0, newlineIndex);
        textBuffer = textBuffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;

        try {
          const raw = JSON.parse(line);
          const event = normalizeLifecycleEvent(raw);
          recordEvent(event, "hook");
          sendNative({ type: "lifecycle.event", event });
          connection.end(`${JSON.stringify({ ok: true })}\n`);
        } catch (error) {
          connection.end(
            `${JSON.stringify({ ok: false, error: error.message })}\n`
          );
        }
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath(), () => {
      server.off("error", reject);
      resolve();
    });
  });
  fs.chmodSync(socketPath(), 0o600);
}

function recordEvent(event, source) {
  const key = sessionKey(event);
  if (event.agent === "claude-code") {
    if (event.type === "work.started") {
      rememberClaudeStart(event);
    }
    if (["work.started", "work.completed", "session.ended"].includes(event.type)) {
      pendingClaudeRejections.delete(event.sessionId);
    }
    if (event.type === "session.ended") {
      latestClaudeStarts.delete(event.sessionId);
    }
  }
  if (event.type === "work.started") {
    sessions.set(key, {
      agent: event.agent,
      surface: event.surface,
      sourceApp: event.sourceApp,
      sessionId: event.sessionId,
      turnId: event.turnId,
      startedAt: event.timestamp
    });
  }
  if (event.type === "session.ended") {
    for (const [candidateKey, session] of sessions) {
      if (
        session.agent === event.agent &&
        session.sessionId === event.sessionId
      ) {
        sessions.delete(candidateKey);
      }
    }
  }
  recordLifecycle(source, event);
}

async function handleExtensionMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "feed.activate") {
    let activated = false;
    try {
      activated = await activateChromeFeed();
    } catch {
      sendNative({
        type: "companion.error",
        message: "The feed opened, but macOS could not bring it to the foreground."
      });
    }
    sendNative({
      type: "feed.activated",
      windowId: message.windowId,
      success: activated
    });
    return;
  }

  if (message.type === "activity.reset") {
    sessions.clear();
    pendingClaudeRejections.clear();
    latestClaudeStarts.clear();
    recordLifecycle("extension", {
      type: message.type,
      agent: "system",
      sessionId: "system",
      timestamp: Date.now()
    });
    return;
  }

  if (
    message.type === "feed.closed" ||
    message.type === "session.return" ||
    message.type === "source.focus"
  ) {
    recordLifecycle("extension", {
      ...message,
      timestamp: Date.now()
    });
    const key = messageKey(message);
    const session = sessions.get(key);
    const source = session ?? message;
    let restored = false;
    let restoreError = null;
    if (source?.sourceApp) {
      try {
        restored = await focusApplication(source.sourceApp);
      } catch (error) {
        restoreError = error;
        await notifyFocusFailure();
      }
    }
    if (message.final !== false) {
      sessions.delete(key);
      persistState();
    }
    sendNative({
      type: "source.restored",
      sessionId: message.sessionId,
      turnId: message.turnId,
      success: restored
    });
    if (restoreError) {
      sendNative({
        type: "companion.error",
        message: "The feed closed, but the source application could not be restored."
      });
    }
    return;
  }

  if (message.type === "source.notify") {
    const key = messageKey(message);
    const session = sessions.get(key);
    await notifyReady(session ?? message);
    if (message.final !== false) {
      sessions.delete(key);
      persistState();
    }
    return;
  }

  if (message.type === "task.release") {
    recordLifecycle("extension", {
      ...message,
      timestamp: Date.now()
    });
    sessions.delete(messageKey(message));
    persistState();
    return;
  }

  if (message.type === "companion.ping") {
    sendNative({
      type: "companion.pong",
      protocolVersion: PROTOCOL_VERSION,
      sessions: sessions.size
    });
  }
}

async function startDecisionReceiver() {
  const config = readClaudeOtelConfig();
  if (!config) return;
  try {
    claudeOtelReceiver = await startClaudeOtelReceiver({
      config,
      onDecision: forwardClaudeDecision,
      onPrompt: forwardClaudePrompt,
      onEvent: forwardClaudeMonitoringEvent
    });
  } catch {
    // Claude continues normally. PostToolUse remains the late resume fallback.
  }
}

function forwardClaudeMonitoringEvent(event) {
  const eventName = String(event.eventName ?? "unknown")
    .replace(/^claude_code\./, "")
    .replace(/[^a-z0-9_.-]/gi, "_")
    .slice(0, 64);
  recordLifecycle("monitoring", {
    type: `otel.${eventName || "unknown"}`,
    agent: "claude-code",
    sessionId: event.sessionId,
    timestamp: event.timestamp,
    sequence: event.sequence,
    promptId: event.promptId,
    querySource: event.querySource
  });
  if (eventName === "api_request") {
    forwardClaudeReplacementRequest(event);
  }
}

function forwardClaudeDecision(decision) {
  const delayedRestart =
    decision.decision === "reject"
      ? claudeStartAfterDecision(decision.sessionId, decision.timestamp)
      : null;
  if (decision.decision === "accept") {
    pendingClaudeRejections.delete(decision.sessionId);
  } else if (delayedRestart) {
    pendingClaudeRejections.delete(decision.sessionId);
  } else {
    pendingClaudeRejections.set(decision.sessionId, {
      sequence: decision.sequence,
      timestamp: decision.timestamp,
      promptId: decision.promptId,
      serviceName: decision.serviceName,
      terminalType: decision.terminalType
    });
    if (pendingClaudeRejections.size > 128) {
      pendingClaudeRejections.delete(
        pendingClaudeRejections.keys().next().value
      );
    }
  }
  const desktop = decision.serviceName === "claude-code-desktop";
  const event = normalizeLifecycleEvent({
    type: decision.decision === "accept" ? "work.resumed" : "work.completed",
    agent: "claude-code",
    surface: desktop ? "desktop" : "cli",
    sessionId: decision.sessionId,
    turnId: "unknown-turn",
    sourceApp: desktop ? "Claude" : sourceAppFromTerminal(decision.terminalType),
    timestamp: decision.timestamp
  });
  recordLifecycle("decision", event);
  sendNative({ type: "lifecycle.event", event });
  if (delayedRestart) {
    recordLifecycle("replay", delayedRestart);
    sendNative({ type: "lifecycle.event", event: delayedRestart });
  }
}

function forwardClaudeReplacementRequest(request) {
  const rejection = pendingClaudeRejections.get(request.sessionId);
  if (
    !rejection ||
    !rejection.promptId ||
    request.promptId !== rejection.promptId ||
    request.querySource !== "main" ||
    !eventFollows(request, rejection)
  ) {
    return;
  }
  pendingClaudeRejections.delete(request.sessionId);

  const desktop = rejection.serviceName === "claude-code-desktop";
  const event = normalizeLifecycleEvent({
    type: "work.started",
    agent: "claude-code",
    surface: desktop ? "desktop" : "cli",
    sessionId: request.sessionId,
    turnId: "unknown-turn",
    sourceApp: desktop
      ? "Claude"
      : sourceAppFromTerminal(rejection.terminalType),
    timestamp: request.timestamp
  });
  rememberClaudeStart(event);
  recordLifecycle("api", event);
  sendNative({ type: "lifecycle.event", event });
}

function forwardClaudePrompt(prompt) {
  const rejection = pendingClaudeRejections.get(prompt.sessionId);
  if (!rejection || !eventFollows(prompt, rejection)) return;
  pendingClaudeRejections.delete(prompt.sessionId);

  const desktop = prompt.serviceName === "claude-code-desktop";
  const event = normalizeLifecycleEvent({
    type: "work.started",
    agent: "claude-code",
    surface: desktop ? "desktop" : "cli",
    sessionId: prompt.sessionId,
    turnId: "unknown-turn",
    sourceApp: desktop ? "Claude" : sourceAppFromTerminal(prompt.terminalType),
    timestamp: prompt.timestamp
  });
  rememberClaudeStart(event);
  recordLifecycle("prompt", event);
  sendNative({ type: "lifecycle.event", event });
}

function rememberClaudeStart(event) {
  latestClaudeStarts.delete(event.sessionId);
  latestClaudeStarts.set(event.sessionId, { ...event });
  if (latestClaudeStarts.size > 128) {
    latestClaudeStarts.delete(latestClaudeStarts.keys().next().value);
  }
}

function claudeStartAfterDecision(sessionId, decisionTimestamp) {
  const event = latestClaudeStarts.get(sessionId);
  return Number.isFinite(event?.timestamp) &&
    Number.isFinite(decisionTimestamp) &&
    event.timestamp > decisionTimestamp
    ? event
    : null;
}

function eventFollows(candidate, previous) {
  try {
    const candidateSequence = BigInt(candidate.sequence);
    const previousSequence = BigInt(previous.sequence);
    return candidateSequence > previousSequence;
  } catch {
    return candidate.timestamp >= previous.timestamp;
  }
}

function sourceAppFromTerminal(terminalType) {
  const terminal = String(terminalType ?? "").toLowerCase();
  if (terminal.includes("iterm")) return "iTerm";
  if (terminal.includes("warp")) return "Warp";
  if (terminal.includes("wezterm")) return "WezTerm";
  if (terminal.includes("ghostty")) return "Ghostty";
  if (terminal.includes("vscode") || terminal.includes("cursor")) {
    return "Visual Studio Code";
  }
  return "Terminal";
}

async function focusApplication(applicationName) {
  if (process.platform !== "darwin") return false;
  const argumentsForOpen =
    applicationName === "Codex"
      ? ["-b", "com.openai.codex"]
      : ["-a", applicationName];
  await execFileAsync("/usr/bin/open", argumentsForOpen, {
    timeout: 2_000
  });
  return true;
}

async function notifyFocusFailure() {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync(
      "/usr/bin/osascript",
      [
        "-e",
        'display notification "The feed closed, but the source app could not be restored." with title "FirstTok"'
      ],
      { timeout: 2_000 }
    );
  } catch {
    // The feed is already closed; notification failure is non-fatal.
  }
}

async function notifyReady(session) {
  if (process.platform !== "darwin") return;
  const agent = session?.agent === "claude-code" ? "Claude Code" : "Codex";
  try {
    await execFileAsync(
      "/usr/bin/osascript",
      [
        "-e",
        `display notification "${agent} is ready." with title "FirstTok"`
      ],
      { timeout: 2_000 }
    );
  } catch {
    // Notification failure must never affect the agent lifecycle.
  }
}

function sendNative(message) {
  if (!extensionConnected) return;
  process.stdout.write(encodeNativeMessage(message));
}

async function prepareRuntime() {
  fs.mkdirSync(runtimeDirectory(), { recursive: true, mode: 0o700 });
  fs.chmodSync(runtimeDirectory(), 0o700);
  cleanupSocket();
  try {
    const state = JSON.parse(fs.readFileSync(statePath(), "utf8"));
    for (const session of state.sessions ?? []) {
      if (session && session.agent && session.sessionId && session.turnId) {
        sessions.set(
          `${session.agent}:${session.sessionId}:${session.turnId}`,
          session
        );
      }
    }
    for (const entry of state.recentLifecycle ?? []) {
      if (
        entry &&
        typeof entry.source === "string" &&
        typeof entry.type === "string" &&
        typeof entry.session === "string" &&
        Number.isFinite(entry.timestamp)
      ) {
        recentLifecycle.push(entry);
      }
    }
    if (recentLifecycle.length > 64) {
      recentLifecycle.splice(0, recentLifecycle.length - 64);
    }
  } catch {
    // A missing or stale state file is safe to ignore.
  }
}

function persistState() {
  const temporary = `${statePath()}.tmp`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({
      version: 1,
      sessions: [...sessions.values()],
      recentLifecycle
    }),
    { mode: 0o600 }
  );
  fs.renameSync(temporary, statePath());
}

function recordLifecycle(source, event) {
  const entry = {
    source,
    type: String(event.type ?? "unknown"),
    agent: String(event.agent ?? "unknown"),
    session: sessionDigest(event.sessionId),
    timestamp: Number.isFinite(event.timestamp) ? event.timestamp : Date.now()
  };
  if (event.sequence != null) {
    entry.sequence = String(event.sequence).slice(0, 24);
  }
  if (event.promptId) {
    entry.prompt = opaqueDigest(event.promptId);
  }
  if (["main", "compact", "other"].includes(event.querySource)) {
    entry.querySource = event.querySource;
  }
  recentLifecycle.push(entry);
  if (recentLifecycle.length > 64) {
    recentLifecycle.splice(0, recentLifecycle.length - 64);
  }
  persistState();
}

function sessionDigest(sessionId) {
  return opaqueDigest(sessionId);
}

function opaqueDigest(value) {
  return crypto
    .createHash("sha256")
    .update(String(value ?? "unknown"))
    .digest("hex")
    .slice(0, 12);
}

function sessionKey(event) {
  return `${event.agent}:${event.sessionId}:${event.turnId}`;
}

function messageKey(message) {
  return `${message.agent}:${message.sessionId}:${message.turnId}`;
}

function cleanupSocket() {
  try {
    if (fs.existsSync(socketPath())) {
      const stat = fs.lstatSync(socketPath());
      if (stat.isSocket()) fs.unlinkSync(socketPath());
    }
  } catch {
    // Cleanup is best effort.
  }
}

function shutdown() {
  extensionConnected = false;
  claudeOtelReceiver?.close();
  server?.close();
  cleanupSocket();
  process.exit(0);
}
