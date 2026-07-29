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

test("installer merges and removes hooks without overwriting existing settings", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-install-"));
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
  assert.match(JSON.stringify(installed), /FIRSTTOK_HOOK/);
  const claudePermissionHook =
    installed.hooks.PermissionRequest[0].hooks[0];
  assert.match(
    claudePermissionHook.command,
    /firsttok-hook\.mjs/
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
        FIRSTTOK_RUNTIME_DIR: path.join(target, "missing-companion")
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
      FIRSTTOK_RUNTIME_DIR: path.join(target, "missing-companion")
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
        "com.firsttok.companion.json"
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
      JSON.stringify(entry).includes("FIRSTTOK_HOOK")
    ).length,
    1
  );

  runInstaller(target, "uninstall", "--all");
  const removed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(removed.model, "existing-model");
  assert.deepEqual(removed.env, { EXISTING_SETTING: "preserved" });
  assert.equal(removed.hooks.Stop.length, 1);
  assert.doesNotMatch(JSON.stringify(removed), /FIRSTTOK_HOOK/);
  assert.equal(fs.existsSync(nativeManifest.path), false);
  assert.equal(fs.existsSync(claudeOtelConfigPath(target)), false);
});

test("installer refuses to replace an existing Claude telemetry destination", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-conflict-"));
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
  assert.match(JSON.stringify(installed.hooks), /FIRSTTOK_HOOK/);

  runInstaller(target, "uninstall", "--claude");
  const removed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(
    removed.env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    "https://telemetry.example.test/v1/logs"
  );
  assert.doesNotMatch(JSON.stringify(removed.hooks), /FIRSTTOK_HOOK/);
});

test("installer preserves an existing Claude telemetry headers helper", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-helper-conflict-"));
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
  assert.match(JSON.stringify(installed.hooks), /FIRSTTOK_HOOK/);
});

test("installed native launcher resolves Node with Chrome's sparse GUI PATH", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-gui-path-"));
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
        "com.firsttok.companion.json"
      ),
      "utf8"
    )
  );
  const probe = spawnSync(manifest.path, ["--firsttok-launch-check"], {
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

function runInstaller(home, action, target) {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "scripts", "install.mjs"), action, target],
    {
      cwd: root,
      env: { ...process.env, FIRSTTOK_HOME: home },
      encoding: "utf8"
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
