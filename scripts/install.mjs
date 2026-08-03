#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NATIVE_HOST_NAME } from "../companion/constants.mjs";
import {
  CLAUDE_OTEL_ENVIRONMENT_KEYS,
  claudeOtelConfigPath,
  claudeOtelEnvironment,
  createClaudeOtelConfig,
  normalizeClaudeOtelConfig,
  readClaudeOtelConfig
} from "../companion/claude-otel-config.mjs";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const productionAppBundle = process.env.GO_ROT_APP_BUNDLE
  ? path.resolve(process.env.GO_ROT_APP_BUNDLE)
  : null;
const targetHome = process.env.GO_ROT_HOME
  ? path.resolve(process.env.GO_ROT_HOME)
  : os.homedir();
const [action = "install", ...targetArguments] = process.argv.slice(2);
const usage =
  "Usage: node scripts/install.mjs <install|uninstall> " +
  "[--all|--native|--codex|--claude] or configure <--codex|--claude>";

if (!["install", "uninstall", "configure"].includes(action)) fail(usage);

if (action === "configure") {
  const selectedAgents = [...new Set(targetArguments.map(parseTarget))];
  if (
    selectedAgents.length === 0 ||
    selectedAgents.some((item) => !["codex", "claude"].includes(item))
  ) {
    fail(usage);
  }
  await configureAgentSetup(selectedAgents);
  console.log("");
  console.log(`Configured Go Rot for: ${selectedAgents.join(", ")}.`);
} else {
  const target = targetArguments[0] ?? "--all";
  if (targetArguments.length > 1) fail(usage);
  const targets =
    target === "--all"
      ? action === "uninstall"
        ? ["claude", "codex", "native"]
        : ["native", "codex", "claude"]
      : [parseTarget(target)];

  for (const item of targets) {
    if (!["native", "codex", "claude"].includes(item)) {
      fail(`Unknown install target: ${item}`);
    }
    if (action === "install") {
      if (item === "native") await installNativeHost();
      if (item === "codex") installHooks("codex");
      if (item === "claude") installHooks("claude-code");
    } else {
      if (item === "native") uninstallNativeHost();
      if (item === "codex") uninstallHooks("codex");
      if (item === "claude") uninstallHooks("claude-code");
    }
  }

  if (action === "install") printInstallSummary(targets);
}

function printInstallSummary(targets) {
  console.log("");
  console.log(
    targets.length === 3
      ? "Go Rot components installed."
      : `Installed Go Rot component: ${targets.join(", ")}.`
  );
  if (targets.includes("native")) {
    if (productionAppBundle) {
      console.log(
        `Chrome extension: https://chromewebstore.google.com/detail/${extensionId()}`
      );
    } else {
      console.log(
        `Load this unpacked extension in Chrome: ${path.join(projectRoot, "extension")}`
      );
    }
    console.log(`Expected extension ID: ${extensionId()}`);
    console.log(
      'Open the Go Rot toolbar button and confirm its status says "Ready to rot."'
    );
  }
  if (targets.includes("codex")) {
    const codexCli = findCodexCli();
    if (codexCli) {
      console.log(`Codex hook approval: ${shellQuote(codexCli)}`);
      console.log('Then enter "/hooks" and trust the Go Rot hooks.');
    } else {
      console.log(
        'Codex requires hook approval: start Codex CLI, enter "/hooks", and trust the Go Rot hooks.'
      );
    }
  }
}

function parseTarget(argument) {
  return argument.replace(/^--/, "");
}

async function configureAgentSetup(selectedAgents) {
  const includesClaude = selectedAgents.includes("claude");
  await installNativeHost({ prepareClaudeReceiver: includesClaude });

  if (selectedAgents.includes("codex")) installHooks("codex");
  else uninstallHooks("codex");

  if (includesClaude) {
    installHooks("claude-code");
  } else {
    uninstallHooks("claude-code");
    removeExactFile(claudeOtelConfigPath(targetHome));
    removeExactFile(legacyClaudeOtelConfigPath());
  }
}

async function installNativeHost({ prepareClaudeReceiver = true } = {}) {
  if (process.platform !== "darwin") {
    fail("The Go Rot installer currently supports macOS only.");
  }
  if (prepareClaudeReceiver) {
    let receiverConfig = readClaudeOtelConfig(targetHome);
    if (!receiverConfig) {
      receiverConfig = createClaudeOtelConfig(await findAvailableLoopbackPort());
    }
    fs.mkdirSync(path.dirname(claudeOtelConfigPath(targetHome)), {
      recursive: true
    });
    writeJson(claudeOtelConfigPath(targetHome), receiverConfig);
  }

  const launcher = nativeLauncherPath();
  if (productionAppBundle) {
    requireExecutable(launcher, "bundled native host");
  } else {
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        'if [ "$1" = "--go-rot-launch-check" ]; then',
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
  }
  const manifestPath = nativeManifestPath();
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeJson(manifestPath, {
    name: NATIVE_HOST_NAME,
    description: "Go Rot local lifecycle companion",
    path: launcher,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId()}/`]
  });
  removeExactFile(legacyNativeManifestPath());
  removeExactFile(legacyInstalledNativeLauncherPath());
  console.log(`Installed Chrome companion: ${manifestPath}`);
  if (prepareClaudeReceiver) {
    console.log("Prepared Claude's authenticated local decision receiver.");
  }
}

function uninstallNativeHost() {
  removeExactFile(nativeManifestPath());
  removeExactFile(installedNativeLauncherPath());
  removeExactFile(claudeOtelConfigPath(targetHome));
  removeExactFile(legacyNativeManifestPath());
  removeExactFile(legacyInstalledNativeLauncherPath());
  removeExactFile(legacyClaudeOtelConfigPath());
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
          "PreToolUse",
          "PermissionRequest",
          "PostToolUse",
          "Stop",
          "SessionEnd"
        ]
      : [
          "UserPromptSubmit",
          "PreToolUse",
          "PermissionRequest",
          "Notification",
          "PostToolUse",
          "Stop",
          "SessionEnd"
        ];

  for (const event of events) {
    config.hooks[event] ??= [];
    removeGoRotEntries(config.hooks[event]);
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
  if (provider === "claude-code") {
    configureClaudeDecisionEvents(config);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  writeJson(destination, config);
  console.log(`Installed ${provider} hooks: ${destination}`);
}

function uninstallHooks(provider) {
  const destination = hookConfigPath(provider);
  const config = readJson(destination, null);
  if (!config) return;
  let changed = false;
  if (config.hooks) {
    for (const [event, entries] of Object.entries(config.hooks)) {
      const removed = removeGoRotEntries(entries);
      if (removed > 0) {
        changed = true;
        if (entries.length === 0) delete config.hooks[event];
      }
    }
  }
  if (provider === "claude-code") {
    changed = removeClaudeDecisionEnvironment(config) || changed;
  }
  if (!changed) return;
  writeJson(destination, config);
  console.log(`Removed Go Rot hooks from: ${destination}`);
}

function removeGoRotEntries(entries) {
  if (!Array.isArray(entries)) return 0;
  let removed = 0;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const serialized = JSON.stringify(entries[index]);
    if (
      serialized.includes("GO_ROT_HOOK") ||
      serialized.includes("FIRSTTOK_HOOK") ||
      serialized.includes("firsttok-hook.mjs")
    ) {
      entries.splice(index, 1);
      removed += 1;
    }
  }
  return removed;
}

function hookCommand(provider) {
  const hookPath = path.join(projectRoot, "bin", "go-rot-hook.mjs");
  return `GO_ROT_HOOK=1 ${shellQuote(process.execPath)} ${shellQuote(
    hookPath
  )} --provider ${provider}`;
}

function configureClaudeDecisionEvents(settings) {
  const receiverConfig = readClaudeOtelConfig(targetHome);
  if (!receiverConfig) {
    console.log(
      "WARNING Claude native permission tracking was not configured because " +
        "the Go Rot companion must be installed first."
    );
    return false;
  }
  const desired = claudeOtelEnvironment(receiverConfig);
  const environment =
    settings.env && typeof settings.env === "object" && !Array.isArray(settings.env)
      ? settings.env
      : {};
  removeLegacyClaudeDecisionEnvironment(environment);
  const alreadyConfigured = Object.entries(desired).every(
    ([key, value]) => String(environment[key]) === value
  );
  const conflicts = alreadyConfigured
    ? []
    : Object.entries(environment)
        .filter(
          ([key, value]) =>
            isClaudeTelemetryKey(key) &&
            (!(key in desired) || String(value) !== desired[key])
        )
        .map(([key]) => key);
  if (settings.otelHeadersHelper) {
    conflicts.push("otelHeadersHelper");
  }
  if (conflicts.length > 0) {
    console.log(
      "WARNING Kept existing Claude telemetry settings unchanged; native " +
        `permission tracking is passive only (${[...new Set(conflicts)].join(", ")}).`
    );
    return false;
  }
  settings.env = { ...environment, ...desired };
  removeExactFile(legacyClaudeOtelConfigPath());
  console.log(
    "Configured native Claude permission decisions for ordinary `claude` sessions."
  );
  return true;
}

function removeClaudeDecisionEnvironment(settings) {
  if (!settings.env || typeof settings.env !== "object") {
    return false;
  }
  let changed = false;
  const receiverConfig = readClaudeOtelConfig(targetHome);
  if (receiverConfig) {
    changed = removeExactClaudeDecisionEnvironment(
      settings.env,
      claudeOtelEnvironment(receiverConfig)
    ) || changed;
  }
  changed = removeLegacyClaudeDecisionEnvironment(settings.env) || changed;
  if (changed && Object.keys(settings.env).length === 0) delete settings.env;
  return changed;
}

function removeLegacyClaudeDecisionEnvironment(environment) {
  const legacyConfig = readLegacyClaudeOtelConfig();
  if (!legacyConfig) return false;
  return removeExactClaudeDecisionEnvironment(
    environment,
    claudeOtelEnvironment(legacyConfig)
  );
}

function removeExactClaudeDecisionEnvironment(environment, owned) {
  const matches = CLAUDE_OTEL_ENVIRONMENT_KEYS.every(
    (key) => String(environment[key]) === owned[key]
  );
  if (!matches) return false;
  for (const key of CLAUDE_OTEL_ENVIRONMENT_KEYS) delete environment[key];
  return true;
}

function readLegacyClaudeOtelConfig() {
  try {
    return normalizeClaudeOtelConfig(
      JSON.parse(fs.readFileSync(legacyClaudeOtelConfigPath(), "utf8"))
    );
  } catch {
    return null;
  }
}

function isClaudeTelemetryKey(key) {
  return (
    key === "CLAUDE_CODE_ENABLE_TELEMETRY" ||
    key.startsWith("OTEL_")
  );
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

function legacyNativeManifestPath() {
  return path.join(
    targetHome,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    "com.firsttok.companion.json"
  );
}

function installedNativeLauncherPath() {
  return path.join(
    targetHome,
    "Library",
    "Application Support",
    "Go Rot",
    "go-rot-native-host"
  );
}

function legacyInstalledNativeLauncherPath() {
  return path.join(
    targetHome,
    "Library",
    "Application Support",
    "FirstTok",
    "firsttok-native-host"
  );
}

function legacyClaudeOtelConfigPath() {
  return path.join(
    targetHome,
    "Library",
    "Application Support",
    "FirstTok",
    "claude-otel.json"
  );
}

function nativeLauncherPath() {
  return productionAppBundle
    ? path.join(
        productionAppBundle,
        "Contents",
        "MacOS",
        "go-rot-native-host"
      )
    : installedNativeLauncherPath();
}

function requireExecutable(filePath, label) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
  } catch {
    fail(`Could not find ${label}: ${filePath}`);
  }
}

async function findAvailableLoopbackPort() {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" ? address?.port : null;
      probe.close((error) => {
        if (error) reject(error);
        else if (Number.isInteger(port)) resolve(port);
        else reject(new Error("Could not allocate a local receiver port."));
      });
    });
  });
}

function findCodexCli() {
  const candidates = [
    process.env.CODEX_CLI_PATH,
    path.join(targetHome, ".local", "bin", "codex"),
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((directory) => path.join(directory, "codex")),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
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
  if (productionAppBundle) {
    return readJson(
      path.join(projectRoot, "release", "release-contract.json")
    ).identifiers.chromeExtension;
  }
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
  const temporary = `${filePath}.go-rot.tmp`;
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
