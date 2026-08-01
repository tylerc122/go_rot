import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagedApp = path.join(root, "dist", "release", "Go Rot.app");
const contract = JSON.parse(
  fs.readFileSync(path.join(root, "release", "release-contract.json"), "utf8")
);

test(
  "packaged Mac setup installs, connects, and removes cleanly in an isolated home",
  {
    skip:
      process.platform !== "darwin" ||
      !fs.existsSync(path.join(packagedApp, "Contents", "Frameworks", "node"))
  },
  async (context) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-production-"));
    const home = path.join(temporary, "home");
    const runtime = path.join(temporary, "runtime");
    const appBundle = path.join(temporary, "Applications", "Go Rot.app");
    const resources = path.join(appBundle, "Contents", "Resources", "app");
    const executable = path.join(appBundle, "Contents", "MacOS", "go-rot");
    const moduleCache = path.join(temporary, "swift-modules");
    fs.mkdirSync(path.dirname(appBundle), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(runtime, { recursive: true });
    fs.mkdirSync(moduleCache, { recursive: true });
    fs.cpSync(packagedApp, appBundle, { recursive: true });
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

    overlayCurrentResources(resources);
    compileCurrentApplication(executable, moduleCache);
    seedExistingSettings(home);

    const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
    const bundledNode = path.join(
      appBundle,
      "Contents",
      "Frameworks",
      "node",
      architecture,
      "bin",
      "node"
    );
    const installer = path.join(resources, "scripts", "install.mjs");
    const environment = {
      ...process.env,
      GO_ROT_HOME: home,
      GO_ROT_APP_BUNDLE: appBundle,
      GO_ROT_NODE: bundledNode,
      GO_ROT_RUNTIME_DIR: runtime,
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin"
    };

    const install = spawnSync(bundledNode, [installer, "install", "--all"], {
      env: environment,
      encoding: "utf8"
    });
    assert.equal(install.status, 0, install.stderr || install.stdout);
    assert.match(install.stdout, /Go Rot components installed/);

    const codexPath = path.join(home, ".codex", "hooks.json");
    const claudePath = path.join(home, ".claude", "settings.json");
    const codex = readJson(codexPath);
    const claude = readJson(claudePath);
    assert.equal(codex.keep, "codex-value");
    assert.equal(claude.keep, "claude-value");
    assert.match(JSON.stringify(codex.hooks), /GO_ROT_HOOK/);
    assert.match(JSON.stringify(claude.hooks), /GO_ROT_HOOK/);
    assert.match(JSON.stringify(codex.hooks), escapeRegExp(bundledNode));
    assert.match(JSON.stringify(claude.hooks), escapeRegExp(bundledNode));
    assert.match(JSON.stringify(codex.hooks), /Contents\/Resources\/app\/bin\/go-rot-hook\.mjs/);

    const nativeManifestPath = path.join(
      home,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
      "NativeMessagingHosts",
      "dev.gorot.companion.json"
    );
    const nativeManifest = readJson(nativeManifestPath);
    assert.equal(
      nativeManifest.path,
      path.join(appBundle, "Contents", "MacOS", "go-rot-native-host")
    );
    assert.deepEqual(nativeManifest.allowed_origins, [
      `chrome-extension://${contract.identifiers.chromeExtension}/`
    ]);

    const host = spawn(nativeManifest.path, [], {
      env: environment,
      stdio: ["pipe", "ignore", "pipe"]
    });
    let hostError = "";
    host.stderr.setEncoding("utf8");
    host.stderr.on("data", (chunk) => {
      hostError += chunk;
    });
    context.after(() => {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    });

    const identityPath = path.join(runtime, "companion.json");
    await waitFor(
      () => fs.existsSync(identityPath),
      () => hostError || "native host did not publish readiness identity"
    );
    assert.deepEqual(readJson(identityPath), {
      host: "dev.gorot.companion",
      protocolVersion: 1,
      extensionId: contract.identifiers.chromeExtension,
      pid: host.pid
    });

    const ready = spawnSync(executable, ["--check-readiness"], {
      env: environment,
      encoding: "utf8"
    });
    assert.equal(ready.status, 0, ready.stderr);
    assert.equal(ready.stdout.trim(), "ready");

    host.stdin.end();
    await new Promise((resolve) => host.once("exit", resolve));
    const stopped = spawnSync(executable, ["--check-readiness"], {
      env: environment,
      encoding: "utf8"
    });
    assert.equal(stopped.status, 1);
    assert.equal(stopped.stdout.trim(), "waiting");

    const uninstall = spawnSync(bundledNode, [installer, "uninstall", "--all"], {
      env: environment,
      encoding: "utf8"
    });
    assert.equal(uninstall.status, 0, uninstall.stderr || uninstall.stdout);
    assert.equal(fs.existsSync(nativeManifestPath), false);
    assert.equal(fs.existsSync(path.join(home, "Library", "Application Support", "Go Rot", "claude-otel.json")), false);

    const restoredCodex = readJson(codexPath);
    const restoredClaude = readJson(claudePath);
    assert.equal(restoredCodex.keep, "codex-value");
    assert.equal(restoredClaude.keep, "claude-value");
    assert.equal(JSON.stringify(restoredCodex).includes("GO_ROT_HOOK"), false);
    assert.equal(JSON.stringify(restoredClaude).includes("GO_ROT_HOOK"), false);
    assert.equal(restoredCodex.hooks.Stop[0].hooks[0].command, "existing-codex-hook");
    assert.equal(restoredClaude.hooks.Stop[0].hooks[0].command, "existing-claude-hook");
  }
);

function overlayCurrentResources(resources) {
  for (const directory of ["bin", "companion", "extension", "integrations"]) {
    fs.cpSync(path.join(root, directory), path.join(resources, directory), {
      recursive: true,
      force: true
    });
  }
  for (const relative of [
    "scripts/install.mjs",
    "scripts/doctor.mjs",
    "release/release-contract.json",
    "package.json"
  ]) {
    const destination = path.join(resources, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
}

function compileCurrentApplication(executable, moduleCache) {
  const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
  const result = spawnSync(
    "/usr/bin/xcrun",
    [
      "--sdk",
      "macosx",
      "swiftc",
      path.join(root, "release", "macos", "GoRotApp.swift"),
      "-target",
      `${architecture}-apple-macosx13.0`,
      "-module-cache-path",
      moduleCache,
      "-framework",
      "Cocoa",
      "-framework",
      "UserNotifications",
      "-o",
      executable
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
        CLANG_MODULE_CACHE_PATH: moduleCache,
        SWIFT_MODULECACHE_PATH: moduleCache
      }
    }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  fs.chmodSync(executable, 0o755);
}

function seedExistingSettings(home) {
  writeJson(path.join(home, ".codex", "hooks.json"), {
    keep: "codex-value",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "existing-codex-hook" }] }]
    }
  });
  writeJson(path.join(home, ".claude", "settings.json"), {
    keep: "claude-value",
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "existing-claude-hook" }] }]
    }
  });
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function escapeRegExp(value) {
  return new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

async function waitFor(predicate, errorMessage) {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(errorMessage());
}
