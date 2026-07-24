#!/usr/bin/env node

import net from "node:net";
import os from "node:os";
import path from "node:path";

const input = await readStandardInput();
const mapped = mapHook(input);

if (mapped) {
  const surface = detectSurface();
  await sendEvent({
    protocolVersion: 1,
    ...mapped,
    agent: "codex",
    surface,
    sessionId: stringValue(input.session_id, "unknown-session"),
    turnId: stringValue(input.turn_id, "unknown-turn"),
    sourceApp: detectSourceApp(surface),
    timestamp: Date.now()
  });
}

function mapHook(payload) {
  switch (payload?.hook_event_name) {
    case "UserPromptSubmit":
      return { type: "work.started" };
    case "PermissionRequest":
      return { type: "attention.required", reason: "permission" };
    case "Stop":
      return { type: "work.completed" };
    case "SessionEnd":
      return { type: "session.ended" };
    default:
      return null;
  }
}

function detectSurface() {
  if (process.env.FIRSTTOK_SURFACE === "cli") return "cli";
  if (process.env.FIRSTTOK_SURFACE === "desktop") return "desktop";
  const clientId = String(input.client_id ?? input.clientId ?? "").toLowerCase();
  if (/(desktop|codex[_-]?app|chatgpt)/.test(clientId)) return "desktop";
  if (/(cli|tui|terminal)/.test(clientId)) return "cli";
  return process.env.TERM_PROGRAM || process.env.TERM || process.env.TTY
    ? "cli"
    : "desktop";
}

function detectSourceApp(surface) {
  if (process.env.FIRSTTOK_SOURCE_APP) {
    return process.env.FIRSTTOK_SOURCE_APP;
  }
  if (surface === "desktop") return "Codex";

  const terminal = String(process.env.TERM_PROGRAM ?? "").toLowerCase();
  if (terminal.includes("iterm")) return "iTerm";
  if (terminal.includes("warp")) return "Warp";
  if (terminal.includes("wezterm")) return "WezTerm";
  if (terminal.includes("ghostty")) return "Ghostty";
  if (terminal.includes("vscode")) return "Visual Studio Code";
  return "Terminal";
}

function runtimeSocketPath() {
  const directory =
    process.env.FIRSTTOK_RUNTIME_DIR ??
    path.join(os.tmpdir(), `firsttok-${process.getuid?.() ?? "user"}`);
  return path.join(directory, "companion.sock");
}

async function readStandardInput() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

async function sendEvent(event) {
  await new Promise((resolve) => {
    const client = net.createConnection(runtimeSocketPath());
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!client.destroyed) client.destroy();
      resolve();
    };
    const timeout = setTimeout(() => {
      client.destroy();
      finish();
    }, 75);
    client.once("connect", () => client.end(`${JSON.stringify(event)}\n`));
    client.once("data", finish);
    client.once("close", finish);
    client.once("error", finish);
  });
}

function stringValue(value, fallback) {
  return typeof value === "string" && value ? value : fallback;
}
