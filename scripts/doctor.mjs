#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME, socketPath } from "../companion/constants.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = process.env.FIRSTTOK_HOME
  ? path.resolve(process.env.FIRSTTOK_HOME)
  : os.homedir();
const checks = [];
const nativeManifest = readJson(nativeManifestPath());
const installedLauncher = nativeManifest?.path;

check("Node.js 20+", Number(process.versions.node.split(".")[0]) >= 20);
check("Chrome extension manifest", fs.existsSync(path.join(root, "extension", "manifest.json")));
check(
  "Codex plugin bundle",
  fs.existsSync(
    path.join(root, "integrations", "firsttok", "hooks", "hooks.json")
  )
);
check("Chrome native host manifest", nativeManifestIsValid(nativeManifest));
check("Chrome-safe native host launcher", nativeLauncherIsValid(installedLauncher));
check(
  "Codex hook config + runtime",
  hookConfigIsValid(path.join(home, ".codex", "hooks.json"))
);
check(
  "Claude Code hook config + runtime",
  hookConfigIsValid(path.join(home, ".claude", "settings.json"))
);
const codexCli = findCodexCli();
check("Codex CLI for hook approval", Boolean(codexCli), true);
check("Companion connection", await socketIsReachable(), true);

console.log(`\nExtension directory: ${path.join(root, "extension")}`);
console.log(`Extension ID: ${extensionId()}`);
console.log("\nACTION  Codex hook approval cannot be checked automatically.");
console.log(
  codexCli
    ? `        Run ${shellQuote(codexCli)}, enter "/hooks", and trust FirstTok.`
    : '        Start Codex CLI, enter "/hooks", and trust the FirstTok hooks.'
);
if (!checks.find((item) => item.label === "Companion connection")?.ok) {
  console.log(
    '\nNEXT    Open chrome://extensions, reload FirstTok, then open its toolbar button.\n' +
      '        Continue only when the extension status says "Ready".'
  );
}

if (checks.some((item) => !item.ok && !item.optional)) {
  process.exitCode = 1;
}

function check(label, ok, optional = false) {
  checks.push({ label, ok, optional });
  const marker = ok ? "PASS" : optional ? "WAIT" : "FAIL";
  console.log(`${marker.padEnd(4)}  ${label}`);
}

function hookConfigIsValid(filePath) {
  try {
    const config = fs.readFileSync(filePath, "utf8");
    return (
      config.includes("FIRSTTOK_HOOK") &&
      config.includes(process.execPath) &&
      config.includes("PostToolUse") &&
      !config.includes("FIRSTTOK_HOOK=1 /usr/bin/env node")
    );
  } catch {
    return false;
  }
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

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function nativeManifestIsValid(manifest) {
  return Boolean(
    manifest &&
      manifest.name === NATIVE_HOST_NAME &&
      manifest.type === "stdio" &&
      path.isAbsolute(manifest.path) &&
      manifest.allowed_origins?.includes(
        `chrome-extension://${extensionId()}/`
      )
  );
}

function nativeLauncherIsValid(launcherPath) {
  if (!launcherPath || !path.isAbsolute(launcherPath)) return false;
  try {
    fs.accessSync(launcherPath, fs.constants.X_OK);
    const launcher = fs.readFileSync(launcherPath, "utf8");
    const shapeIsValid =
      launcher.includes(path.join(root, "companion", "native-host.mjs")) &&
      !launcher.includes("/usr/bin/env node");
    if (!shapeIsValid) return false;

    const probe = spawnSync(launcherPath, ["--firsttok-launch-check"], {
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
      },
      encoding: "utf8",
      timeout: 2_000
    });
    const major = Number(probe.stdout.trim().match(/^v(\d+)/)?.[1]);
    return probe.status === 0 && major >= 20;
  } catch {
    return false;
  }
}

async function socketIsReachable() {
  return await new Promise((resolve) => {
    const client = net.createConnection(socketPath());
    let settled = false;
    const finish = (reachable) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.destroy();
      resolve(reachable);
    };
    const timeout = setTimeout(() => finish(false), 250);
    client.once("connect", () => finish(true));
    client.once("error", () => finish(false));
  });
}

function nativeManifestPath() {
  return path.join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    `${NATIVE_HOST_NAME}.json`
  );
}

function extensionId() {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8")
  );
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest();
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join("");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
