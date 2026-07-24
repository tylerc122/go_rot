#!/usr/bin/env node

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
import { NativeMessageDecoder, encodeNativeMessage } from "./native-framing.mjs";
import { normalizeLifecycleEvent } from "./protocol.mjs";

const execFileAsync = promisify(execFile);
const sessions = new Map();
const nativeDecoder = new NativeMessageDecoder();
let extensionConnected = true;
let server;

await prepareRuntime();
startNativeInput();
await startSocketServer();
sendNative({
  type: "companion.ready",
  protocolVersion: PROTOCOL_VERSION,
  host: NATIVE_HOST_NAME,
  socketPath: socketPath()
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
          recordEvent(event);
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

function recordEvent(event) {
  const key = sessionKey(event);
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
  persistState();
}

async function handleExtensionMessage(message) {
  if (!message || typeof message !== "object") return;

  if (
    message.type === "feed.closed" ||
    message.type === "session.return" ||
    message.type === "source.focus"
  ) {
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
  } catch {
    // A missing or stale state file is safe to ignore.
  }
}

function persistState() {
  const temporary = `${statePath()}.tmp`;
  fs.writeFileSync(
    temporary,
    JSON.stringify({ version: 1, sessions: [...sessions.values()] }),
    { mode: 0o600 }
  );
  fs.renameSync(temporary, statePath());
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
  server?.close();
  cleanupSocket();
  process.exit(0);
}
