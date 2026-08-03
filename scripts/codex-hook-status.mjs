#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";

const targetHome = process.env.GO_ROT_HOME
  ? path.resolve(process.env.GO_ROT_HOME)
  : os.homedir();
const hooksPath = path.join(targetHome, ".codex", "hooks.json");
const timeoutMilliseconds = Number(process.env.GO_ROT_CODEX_STATUS_TIMEOUT ?? 5_000);
const appVersion = readAppVersion();

if (process.env.GO_ROT_CODEX_HOOKS_TRUSTED === "1") {
  finish({ installed: true, trusted: true, reason: "test_override" }, 0);
}
if (process.env.GO_ROT_CODEX_HOOKS_TRUSTED === "0") {
  finish({ installed: true, trusted: false, reason: "test_override" }, 2);
}

const expectedHandlers = readGoRotHandlers();
if (expectedHandlers.length === 0) {
  finish({ installed: false, trusted: false, reason: "not_installed" }, 2);
}

const codexCli = findCodexCli();
if (!codexCli) {
  finish({ installed: true, trusted: false, reason: "codex_cli_missing" }, 3);
}

const child = spawn(codexCli, ["app-server"], {
  env: process.env,
  stdio: ["pipe", "pipe", "ignore"]
});
const lines = readline.createInterface({ input: child.stdout });
let completed = false;

const timeout = setTimeout(() => {
  complete(
    { installed: true, trusted: false, reason: "codex_status_timeout" },
    3
  );
}, timeoutMilliseconds);

child.once("error", () => {
  complete({ installed: true, trusted: false, reason: "codex_cli_failed" }, 3);
});

child.once("exit", () => {
  if (!completed) {
    complete(
      { installed: true, trusted: false, reason: "codex_status_unavailable" },
      3,
      false
    );
  }
});

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (message.id === 0 && message.result) {
    send({ method: "initialized", params: {} });
    send({
      method: "hooks/list",
      id: 1,
      params: { cwds: [targetHome] }
    });
    return;
  }

  if (message.id !== 1) return;
  if (message.error) {
    complete(
      { installed: true, trusted: false, reason: "codex_status_unavailable" },
      3
    );
    return;
  }

  const discovered = Array.isArray(message.result?.data)
    ? message.result.data.flatMap((entry) => entry.hooks ?? [])
    : [];
  const installed = discovered.filter(
    (hook) =>
      path.resolve(String(hook.sourcePath ?? "")) === path.resolve(hooksPath) &&
      String(hook.command ?? "").includes("GO_ROT_HOOK=1") &&
      String(hook.command ?? "").includes("--provider codex")
  );
  const trusted =
    installed.length === expectedHandlers.length &&
    installed.every(
      (hook) => hook.enabled !== false && hook.trustStatus === "trusted"
    );
  complete(
    {
      installed: true,
      trusted,
      reason: trusted ? "trusted" : "approval_required",
      expected: expectedHandlers.length,
      discovered: installed.length
    },
    trusted ? 0 : 2
  );
});

send({
  method: "initialize",
  id: 0,
  params: {
    clientInfo: {
      name: "go_rot",
      title: "Go Rot",
      version: appVersion
    }
  }
});

function readGoRotHandlers() {
  try {
    const config = JSON.parse(fs.readFileSync(hooksPath, "utf8"));
    return Object.values(config.hooks ?? {}).flatMap((groups) =>
      (Array.isArray(groups) ? groups : []).flatMap((group) =>
        (Array.isArray(group?.hooks) ? group.hooks : []).filter(
          (handler) =>
            String(handler?.command ?? "").includes("GO_ROT_HOOK=1") &&
            String(handler?.command ?? "").includes("--provider codex")
        )
      )
    );
  } catch {
    return [];
  }
}

function readAppVersion() {
  try {
    return JSON.parse(
      fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ).version;
  } catch {
    return "unknown";
  }
}

function findCodexCli() {
  const candidates = [
    process.env.GO_ROT_CODEX_CLI,
    process.env.CODEX_CLI_PATH,
    path.join(targetHome, ".local", "bin", "codex"),
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "codex")),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/ChatGPT.app/Contents/Resources/codex"
  ];
  return candidates.find((candidate) => {
    if (!candidate) return false;
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function send(message) {
  if (!child.stdin.destroyed) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
}

function complete(result, status, stopChild = true) {
  if (completed) return;
  completed = true;
  clearTimeout(timeout);
  lines.close();
  if (stopChild && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
  }
  finish(result, status);
}

function finish(result, status) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(status);
}
