#!/usr/bin/env node

import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME, socketPath } from "../companion/constants.mjs";
import {
  claudeOtelEnvironment,
  readClaudeOtelConfig
} from "../companion/claude-otel-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const productionAppBundle = process.env.GO_ROT_APP_BUNDLE
  ? path.resolve(process.env.GO_ROT_APP_BUNDLE)
  : null;
const surface = parseSurface(process.argv.slice(2));
const home = process.env.GO_ROT_HOME
  ? path.resolve(process.env.GO_ROT_HOME)
  : os.homedir();
const checks = [];
const nativeManifest = readJson(nativeManifestPath());
const installedLauncher = nativeManifest?.path;
const claudeOtelConfig = readClaudeOtelConfig(home);
const claudeCli = surface === "codex" ? null : findClaudeCli();

check("Node.js 20+", Number(process.versions.node.split(".")[0]) >= 20);
check("Chrome extension manifest", fs.existsSync(path.join(root, "extension", "manifest.json")));
if (surface !== "claude") {
  check(
    "Codex plugin bundle",
    fs.existsSync(
      path.join(root, "integrations", "go-rot", "hooks", "hooks.json")
    )
  );
}
check("Chrome native host manifest", nativeManifestIsValid(nativeManifest));
check("Chrome-safe native host launcher", nativeLauncherIsValid(installedLauncher));
if (surface !== "claude") {
  check(
    "Codex hook config + runtime",
    hookConfigIsValid(path.join(home, ".codex", "hooks.json"))
  );
}
if (surface !== "codex") {
  check(
    "Claude replacement signal (2.1.220+)",
    claudeVersionIsCompatible(claudeCli),
    true
  );
  const claudeSettingsPath = path.join(home, ".claude", "settings.json");
  check(
    "Claude Code hook config + runtime",
    hookConfigIsValid(claudeSettingsPath)
  );
  check(
    "Claude native permission tracking",
    claudeDecisionEnvironmentIsValid(
      readJson(claudeSettingsPath),
      claudeOtelConfig
    )
  );
}
const codexCli = surface === "claude" ? null : findCodexCli();
if (surface !== "claude") {
  check("Codex CLI for hook approval", Boolean(codexCli), true);
}
check("Companion connection", await socketIsReachable(), true);
if (surface !== "codex") {
  check(
    "Claude decision receiver",
    await claudeDecisionReceiverIsReachable(claudeOtelConfig),
    true
  );
}

console.log(`\nExtension directory: ${path.join(root, "extension")}`);
console.log(`Extension ID: ${extensionId()}`);
if (surface !== "claude") {
  console.log("\nACTION  Codex hook approval cannot be checked automatically.");
  console.log(
    codexCli
      ? `        Run ${shellQuote(codexCli)}, enter "/hooks", and trust Go Rot.`
      : '        Start Codex CLI, enter "/hooks", and trust the Go Rot hooks.'
  );
}
if (!checks.find((item) => item.label === "Companion connection")?.ok) {
  console.log(
    '\nNEXT    Open chrome://extensions, reload Go Rot, then open its toolbar button.\n' +
      '        Continue only when the extension status says "Ready to rot."'
  );
}

if (checks.some((item) => !item.ok && !item.optional)) {
  process.exitCode = 1;
}

function parseSurface(args) {
  if (args.length === 0) return "all";
  if (
    args.length === 2 &&
    args[0] === "--surface" &&
    ["claude", "codex"].includes(args[1])
  ) {
    return args[1];
  }
  console.error("Usage: node scripts/doctor.mjs [--surface claude|codex]");
  process.exit(1);
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
      config.includes("GO_ROT_HOOK") &&
      config.includes(process.execPath) &&
      config.includes("PostToolUse") &&
      !config.includes("claude-permission-hook.mjs") &&
      !config.includes("GO_ROT_HOOK=1 /usr/bin/env node")
    );
  } catch {
    return false;
  }
}

function claudeDecisionEnvironmentIsValid(settings, receiverConfig) {
  if (!settings || !receiverConfig || settings.otelHeadersHelper) return false;
  const expected = claudeOtelEnvironment(receiverConfig);
  return Object.entries(expected).every(
    ([key, value]) => String(settings.env?.[key]) === value
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

function findClaudeCli() {
  const candidates = [
    process.env.CLAUDE_CLI_PATH,
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "claude"))
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

function claudeVersionIsCompatible(cliPath) {
  if (!cliPath) return false;
  try {
    const result = spawnSync(cliPath, ["--version"], {
      encoding: "utf8",
      timeout: 2_000
    });
    if (result.status !== 0) return false;
    const match = result.stdout.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!match) return false;
    const version = match.slice(1).map(Number);
    const minimum = [2, 1, 220];
    for (let index = 0; index < minimum.length; index += 1) {
      if (version[index] !== minimum[index]) {
        return version[index] > minimum[index];
      }
    }
    return true;
  } catch {
    return false;
  }
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
    const productionLauncher = launcherPath.endsWith(
      path.join("Contents", "MacOS", "go-rot-native-host")
    );
    const launcher = productionLauncher
      ? ""
      : fs.readFileSync(launcherPath, "utf8");
    const shapeIsValid = productionLauncher || (
      launcher.includes(path.join(root, "companion", "native-host.mjs")) &&
      !launcher.includes("/usr/bin/env node")
    );
    if (!shapeIsValid) return false;

    const probe = spawnSync(launcherPath, ["--go-rot-launch-check"], {
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

async function claudeDecisionReceiverIsReachable(config) {
  if (!config) return false;
  return await new Promise((resolve) => {
    const request = http.request(
      {
        host: config.host,
        port: config.port,
        path: "/health",
        method: "GET",
        headers: {
          Authorization: `Bearer ${config.token}`
        },
        timeout: 250
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      }
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
    request.end();
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
  if (productionAppBundle) {
    return JSON.parse(
      fs.readFileSync(
        path.join(root, "release", "release-contract.json"),
        "utf8"
      )
    ).identifiers.chromeExtension;
  }
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
