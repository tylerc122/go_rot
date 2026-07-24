#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME } from "../companion/constants.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const targetHome = process.env.FIRSTTOK_HOME
  ? path.resolve(process.env.FIRSTTOK_HOME)
  : os.homedir();
const [action = "install", target = "--all"] = process.argv.slice(2);
const targets = target === "--all" ? ["native", "codex", "claude"] : [target.replace(/^--/, "")];

if (!["install", "uninstall"].includes(action)) {
  fail("Usage: node scripts/install.mjs <install|uninstall> [--all|--native|--codex|--claude]");
}

for (const item of targets) {
  if (!["native", "codex", "claude"].includes(item)) {
    fail(`Unknown install target: ${item}`);
  }
  if (action === "install") {
    if (item === "native") installNativeHost();
    if (item === "codex") installHooks("codex");
    if (item === "claude") installHooks("claude-code");
  } else {
    if (item === "native") uninstallNativeHost();
    if (item === "codex") uninstallHooks("codex");
    if (item === "claude") uninstallHooks("claude-code");
  }
}

if (action === "install") {
  console.log("");
  console.log(
    targets.length === 3
      ? "FirstTok MVP components installed."
      : `Installed FirstTok component: ${targets.join(", ")}.`
  );
  if (targets.includes("native")) {
    console.log(
      `Load this unpacked extension in Chrome: ${path.join(projectRoot, "extension")}`
    );
    console.log(`Expected extension ID: ${extensionId()}`);
    console.log(
      'Open the FirstTok toolbar button and confirm its status says "Ready".'
    );
  }
  if (targets.includes("codex")) {
    const codexCli = findCodexCli();
    if (codexCli) {
      console.log(`Codex hook approval: ${shellQuote(codexCli)}`);
      console.log('Then enter "/hooks" and trust the FirstTok hooks.');
    } else {
      console.log(
        'Codex requires hook approval: start Codex CLI, enter "/hooks", and trust the FirstTok hooks.'
      );
    }
  }
}

function installNativeHost() {
  if (process.platform !== "darwin") {
    fail("The MVP installer currently supports macOS only.");
  }
  const launcher = installedNativeLauncherPath();
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(
    launcher,
    [
      "#!/bin/sh",
      'if [ "$1" = "--firsttok-launch-check" ]; then',
      `  exec ${shellQuote(process.execPath)} --version`,
      "fi",
      `exec ${shellQuote(process.execPath)} ${shellQuote(
        path.join(projectRoot, "companion", "native-host.mjs")
      )}`,
      ""
    ].join("\n"),
    { mode: 0o700 }
  );
  fs.chmodSync(launcher, 0o700);
  const manifestPath = nativeManifestPath();
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeJson(manifestPath, {
    name: NATIVE_HOST_NAME,
    description: "FirstTok local lifecycle companion",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId()}/`]
  });
  console.log(`Installed Chrome companion: ${manifestPath}`);
}

function uninstallNativeHost() {
  removeExactFile(nativeManifestPath());
  removeExactFile(installedNativeLauncherPath());
  console.log(`Removed Chrome companion manifest: ${nativeManifestPath()}`);
}

function installHooks(provider) {
  const destination = hookConfigPath(provider);
  const config = readJson(destination, {});
  config.hooks ??= {};

  const events =
    provider === "codex"
      ? [
          "UserPromptSubmit",
          "PermissionRequest",
          "PostToolUse",
          "Stop",
          "SessionEnd"
        ]
      : [
          "UserPromptSubmit",
          "PermissionRequest",
          "Notification",
          "PostToolUse",
          "Stop",
          "SessionEnd"
        ];

  for (const event of events) {
    config.hooks[event] ??= [];
    removeFirstTokEntries(config.hooks[event]);
    config.hooks[event].push({
      hooks: [
        {
          type: "command",
          command: hookCommand(provider),
          timeout: 2
        }
      ]
    });
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  writeJson(destination, config);
  console.log(`Installed ${provider} hooks: ${destination}`);
}

function uninstallHooks(provider) {
  const destination = hookConfigPath(provider);
  const config = readJson(destination, null);
  if (!config?.hooks) return;
  for (const [event, entries] of Object.entries(config.hooks)) {
    removeFirstTokEntries(entries);
    if (entries.length === 0) delete config.hooks[event];
  }
  writeJson(destination, config);
  console.log(`Removed FirstTok hooks from: ${destination}`);
}

function removeFirstTokEntries(entries) {
  if (!Array.isArray(entries)) return;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const serialized = JSON.stringify(entries[index]);
    if (serialized.includes("FIRSTTOK_HOOK")) entries.splice(index, 1);
  }
}

function hookCommand(provider) {
  const hookPath = path.join(projectRoot, "bin", "firsttok-hook.mjs");
  return `FIRSTTOK_HOOK=1 ${shellQuote(process.execPath)} ${shellQuote(
    hookPath
  )} --provider ${provider}`;
}

function hookConfigPath(provider) {
  return provider === "codex"
    ? path.join(targetHome, ".codex", "hooks.json")
    : path.join(targetHome, ".claude", "settings.json");
}

function nativeManifestPath() {
  return path.join(
    targetHome,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${NATIVE_HOST_NAME}.json`
  );
}

function installedNativeLauncherPath() {
  return path.join(
    targetHome,
    "Library",
    "Application Support",
    "FirstTok",
    "firsttok-native-host"
  );
}

function findCodexCli() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "codex")),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex"
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

function extensionId() {
  const manifest = readJson(path.join(projectRoot, "extension", "manifest.json"));
  const publicKey = Buffer.from(manifest.key, "base64");
  const digest = crypto.createHash("sha256").update(publicKey).digest();
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .map((nibble) => String.fromCharCode("a".charCodeAt(0) + nibble))
    .join("");
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && arguments.length > 1) return fallback;
    fail(`Could not read JSON at ${filePath}: ${error.message}`);
  }
}

function writeJson(filePath, value) {
  const temporary = `${filePath}.firsttok.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600
  });
  fs.renameSync(temporary, filePath);
}

function removeExactFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
