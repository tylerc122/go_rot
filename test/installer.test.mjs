import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_OTEL_ENVIRONMENT_KEYS,
  claudeOtelConfigPath,
  claudeOtelEnvironment,
  readClaudeOtelConfig
} from "../companion/claude-otel-config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releaseContract = JSON.parse(
  fs.readFileSync(path.join(root, "release", "release-contract.json"), "utf8")
);

test("installer merges and removes hooks without overwriting existing settings", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-install-"));
  const claudeSettings = path.join(target, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(
    claudeSettings,
    JSON.stringify({
      model: "existing-model",
      env: { EXISTING_SETTING: "preserved" },
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "existing-hook" }] }]
      }
    })
  );

  const installResult = runInstaller(target, "install", "--all");
  assert.match(installResult.stdout, /status says "Ready to rot\."/);
  assert.match(installResult.stdout, /enter "\/hooks"/);
  const installed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(installed.model, "existing-model");
  assert.equal(installed.hooks.Stop.length, 2);
  assert.ok(installed.hooks.PreToolUse);
  assert.match(JSON.stringify(installed), /GO_ROT_HOOK/);
  const claudePermissionHook =
    installed.hooks.PermissionRequest[0].hooks[0];
  assert.match(
    claudePermissionHook.command,
    /go-rot-hook\.mjs/
  );
  assert.match(claudePermissionHook.command, /--provider claude-code/);
  assert.equal(claudePermissionHook.timeout, 2);
  const receiverConfig = readClaudeOtelConfig(target);
  assert.ok(receiverConfig);
  assert.equal(
    fs.statSync(claudeOtelConfigPath(target)).mode & 0o777,
    0o600
  );
  assert.deepEqual(
    Object.fromEntries(
      CLAUDE_OTEL_ENVIRONMENT_KEYS.map((key) => [key, installed.env[key]])
    ),
    claudeOtelEnvironment(receiverConfig)
  );
  assert.equal(installed.env.EXISTING_SETTING, "preserved");

  const missingCompanion = spawnSync(
    "/bin/sh",
    ["-c", claudePermissionHook.command],
    {
      cwd: root,
      env: {
        ...process.env,
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        GO_ROT_RUNTIME_DIR: path.join(target, "missing-companion")
      },
      input: JSON.stringify({
        hook_event_name: "PermissionRequest",
        session_id: "permission-fallback",
        tool_name: "Bash",
        tool_input: { command: "private command" }
      }),
      encoding: "utf8",
      timeout: 1_000
    }
  );
  assert.equal(missingCompanion.status, 0, missingCompanion.stderr);
  assert.equal(missingCompanion.stdout, "");

  const codexHooks = JSON.parse(
    fs.readFileSync(path.join(target, ".codex", "hooks.json"), "utf8")
  );
  assert.ok(codexHooks.hooks.UserPromptSubmit);
  assert.ok(codexHooks.hooks.PreToolUse);
  assert.ok(codexHooks.hooks.PostToolUse);
  const codexHookCommand =
    codexHooks.hooks.UserPromptSubmit[0].hooks[0].command;
  assert.match(codexHookCommand, new RegExp(escapeRegExp(process.execPath)));
  assert.doesNotMatch(codexHookCommand, /\/usr\/bin\/env node/);
  const sparsePathHook = spawnSync("/bin/sh", ["-c", codexHookCommand], {
    cwd: root,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      GO_ROT_RUNTIME_DIR: path.join(target, "missing-companion")
    },
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "sparse-path",
      turn_id: "sparse-path"
    }),
    encoding: "utf8"
  });
  assert.equal(sparsePathHook.status, 0, sparsePathHook.stderr);

  const nativeManifest = JSON.parse(
    fs.readFileSync(
      path.join(
        target,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
        "dev.gorot.companion.json"
      ),
      "utf8"
    )
  );
  assert.match(nativeManifest.allowed_origins[0], /^chrome-extension:\/\/[a-p]{32}\/$/);
  assert.equal(path.isAbsolute(nativeManifest.path), true);
  assert.equal(fs.existsSync(nativeManifest.path), true);
  assert.equal(fs.statSync(nativeManifest.path).mode & 0o777, 0o700);
  assert.match(fs.readFileSync(nativeManifest.path, "utf8"), /native-host\.mjs/);
  assert.doesNotMatch(
    fs.readFileSync(nativeManifest.path, "utf8"),
    /\/usr\/bin\/env node/
  );

  const reinstallResult = runInstaller(target, "install", "--all");
  assert.doesNotMatch(reinstallResult.stdout, /passive only/);
  assert.deepEqual(readClaudeOtelConfig(target), receiverConfig);
  const reinstalled = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(
    reinstalled.hooks.PermissionRequest.filter((entry) =>
      JSON.stringify(entry).includes("GO_ROT_HOOK")
    ).length,
    1
  );

  runInstaller(target, "uninstall", "--all");
  const removed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(removed.model, "existing-model");
  assert.deepEqual(removed.env, { EXISTING_SETTING: "preserved" });
  assert.equal(removed.hooks.Stop.length, 1);
  assert.doesNotMatch(JSON.stringify(removed), /GO_ROT_HOOK/);
  assert.equal(fs.existsSync(nativeManifest.path), false);
  assert.equal(fs.existsSync(claudeOtelConfigPath(target)), false);
});

test("installer refuses to replace an existing Claude telemetry destination", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-conflict-"));
  const claudeSettings = path.join(target, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(
    claudeSettings,
    JSON.stringify({
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: "1",
        OTEL_LOGS_EXPORTER: "otlp",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:
          "https://telemetry.example.test/v1/logs"
      }
    })
  );

  runInstaller(target, "install", "--native");
  const result = runInstaller(target, "install", "--claude");
  assert.match(result.stdout, /Kept existing Claude telemetry settings unchanged/);

  const installed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(
    installed.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    "https://telemetry.example.test/v1/logs"
  );
  assert.equal(installed.env.OTEL_LOGS_EXPORTER, "otlp");
  assert.equal(installed.env.OTEL_METRICS_EXPORTER, undefined);
  assert.match(JSON.stringify(installed.hooks), /GO_ROT_HOOK/);

  runInstaller(target, "uninstall", "--claude");
  const removed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(
    removed.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    "https://telemetry.example.test/v1/logs"
  );
  assert.doesNotMatch(JSON.stringify(removed.hooks), /GO_ROT_HOOK/);
});

test("installer preserves an existing Claude telemetry headers helper", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-helper-conflict-"));
  const claudeSettings = path.join(target, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(
    claudeSettings,
    JSON.stringify({
      otelHeadersHelper: "/usr/local/bin/existing-headers-helper"
    })
  );

  runInstaller(target, "install", "--native");
  const result = runInstaller(target, "install", "--claude");
  assert.match(result.stdout, /otelHeadersHelper/);

  const installed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(
    installed.otelHeadersHelper,
    "/usr/local/bin/existing-headers-helper"
  );
  assert.equal(installed.env, undefined);
  assert.match(JSON.stringify(installed.hooks), /GO_ROT_HOOK/);
});

test("installed native launcher resolves Node with Chrome's sparse GUI PATH", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-gui-path-"));
  runInstaller(target, "install", "--native");

  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(
        target,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
        "dev.gorot.companion.json"
      ),
      "utf8"
    )
  );
  const probe = spawnSync(manifest.path, ["--go-rot-launch-check"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
    },
    encoding: "utf8"
  });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /^v\d+\./);
});

test("production install points Chrome at the bundled host and public extension", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-production-"));
  const appBundle = path.join(target, "Applications", "Go Rot.app");
  const bundledHost = path.join(
    appBundle,
    "Contents",
    "MacOS",
    "go-rot-native-host"
  );
  fs.mkdirSync(path.dirname(bundledHost), { recursive: true });
  fs.writeFileSync(bundledHost, "#!/bin/sh\nexec \"$GO_ROT_NODE\" --version\n", {
    mode: 0o755
  });

  runInstaller(target, "install", "--native", { GO_ROT_APP_BUNDLE: appBundle });
  const manifest = JSON.parse(
    fs.readFileSync(
      path.join(
        target,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
        "dev.gorot.companion.json"
      ),
      "utf8"
    )
  );
  assert.equal(manifest.path, bundledHost);
  assert.deepEqual(manifest.allowed_origins, [
    `chrome-extension://${releaseContract.identifiers.chromeExtension}/`
  ]);

  runInstaller(target, "uninstall", "--native", { GO_ROT_APP_BUNDLE: appBundle });
  assert.equal(fs.existsSync(nativeManifestPath(target)), false);
});

function runInstaller(home, action, target, environment = {}) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "install.mjs"), action, target],
    {
      cwd: root,
      env: { ...process.env, GO_ROT_HOME: home, ...environment },
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function nativeManifestPath(home) {
  return path.join(
    home,
    "Library",
    "Application Support",
    "Google",
    "Chrome",
    "NativeMessagingHosts",
    "dev.gorot.companion.json"
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
