import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("installer merges and removes hooks without overwriting existing settings", () => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-install-"));
  const claudeSettings = path.join(target, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(
    claudeSettings,
    JSON.stringify({
      model: "existing-model",
      hooks: {
        Stop: [{ hooks: [{ type: "command", command: "existing-hook" }] }]
      }
    })
  );

  const installResult = runInstaller(target, "install", "--all");
  assert.match(installResult.stdout, /status says "Ready"/);
  assert.match(installResult.stdout, /enter "\/hooks"/);
  const installed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(installed.model, "existing-model");
  assert.equal(installed.hooks.Stop.length, 2);
  assert.match(JSON.stringify(installed), /FIRSTTOK_HOOK/);

  const codexHooks = JSON.parse(
    fs.readFileSync(path.join(target, ".codex", "hooks.json"), "utf8")
  );
  assert.ok(codexHooks.hooks.UserPromptSubmit);
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

  runInstaller(target, "uninstall", "--all");
  const removed = JSON.parse(fs.readFileSync(claudeSettings, "utf8"));
  assert.equal(removed.model, "existing-model");
  assert.equal(removed.hooks.Stop.length, 1);
  assert.doesNotMatch(JSON.stringify(removed), /FIRSTTOK_HOOK/);
  assert.equal(fs.existsSync(nativeManifest.path), false);
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
