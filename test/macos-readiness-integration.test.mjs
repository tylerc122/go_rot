import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test(
  "macOS readiness requires an agent hook, the production extension, and a live companion",
  { skip: process.platform !== "darwin" },
  async (context) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-readiness-"));
    const home = path.join(temporary, "home");
    const runtime = path.join(temporary, "runtime");
    const socketPath = path.join(runtime, "companion.sock");
    const identityPath = path.join(runtime, "companion.json");
    const binary = path.join(temporary, "go-rot-readiness");
    const moduleCache = path.join(temporary, "swift-modules");
    const productionExtension = "aelnemadklcpfldiphgoblnkonmebinm";
    const developmentExtension = "kdioecoelofnlhihkiadpmknlfdmmopn";
    fs.mkdirSync(runtime, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(moduleCache, { recursive: true });
    context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

    const architecture = process.arch === "arm64" ? "arm64" : "x86_64";
    const compilation = spawnSync(
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
        binary
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
    assert.equal(compilation.status, 0, compilation.stderr || compilation.stdout);

    const probe = (trusted = "0") =>
      spawnSync(binary, ["--check-readiness"], {
        encoding: "utf8",
        env: {
          ...process.env,
          GO_ROT_HOME: home,
          GO_ROT_RUNTIME_DIR: runtime,
          GO_ROT_EXPECTED_EXTENSION_ID: productionExtension,
          GO_ROT_CODEX_HOOKS_TRUSTED: trusted
        }
      });

    const missing = probe();
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout.trim(), "waiting");

    const codexHooks = path.join(home, ".codex", "hooks.json");
    fs.mkdirSync(path.dirname(codexHooks), { recursive: true });
    fs.writeFileSync(
      codexHooks,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ command: "GO_ROT_HOOK=1 test" }] }]
        }
      })
    );
    const hookOnly = probe();
    assert.equal(hookOnly.status, 1);
    assert.equal(hookOnly.stdout.trim(), "waiting");

    const developmentServer = startCompanion(
      socketPath,
      identityPath,
      developmentExtension
    );
    context.after(() => {
      if (developmentServer.exitCode === null && developmentServer.signalCode === null) {
        developmentServer.kill("SIGKILL");
      }
    });
    await waitForReady(developmentServer);

    const unpacked = probe();
    assert.equal(unpacked.status, 1);
    assert.equal(unpacked.stdout.trim(), "waiting");

    developmentServer.kill("SIGKILL");
    await once(developmentServer, "exit");
    assert.equal(fs.existsSync(socketPath), true, "crash should leave a stale socket file");

    const staleDevelopment = probe();
    assert.equal(staleDevelopment.status, 1);
    assert.equal(staleDevelopment.stdout.trim(), "waiting");

    const productionServer = startCompanion(
      socketPath,
      identityPath,
      productionExtension
    );
    context.after(() => {
      if (productionServer.exitCode === null && productionServer.signalCode === null) {
        productionServer.kill("SIGKILL");
      }
    });
    await waitForReady(productionServer);

    fs.rmSync(codexHooks);
    const liveWithoutHook = probe();
    assert.equal(liveWithoutHook.status, 1);
    assert.equal(liveWithoutHook.stdout.trim(), "waiting");
    fs.mkdirSync(path.dirname(codexHooks), { recursive: true });
    fs.writeFileSync(
      codexHooks,
      JSON.stringify({
        hooks: {
          Stop: [{ hooks: [{ command: "GO_ROT_HOOK=1 test" }] }]
        }
      })
    );
    const liveWithoutTrust = probe();
    assert.equal(liveWithoutTrust.status, 1);
    assert.equal(liveWithoutTrust.stdout.trim(), "waiting");

    const live = probe("1");
    assert.equal(live.status, 0, live.stderr);
    assert.equal(live.stdout.trim(), "ready");

    productionServer.kill("SIGKILL");
    await once(productionServer, "exit");
    assert.equal(fs.existsSync(socketPath), true, "crash should leave a stale socket file");

    const stale = probe();
    assert.equal(stale.status, 1);
    assert.equal(stale.stdout.trim(), "waiting");
  }
);

function startCompanion(socketPath, identityPath, extensionId) {
  return spawn(
    process.execPath,
    [
      "-e",
      [
        'const net = require("node:net");',
        'const fs = require("node:fs");',
        "fs.rmSync(process.env.GO_ROT_TEST_SOCKET, { force: true });",
        "const server = net.createServer((connection) => connection.end());",
        "server.listen(process.env.GO_ROT_TEST_SOCKET, () => {",
        "fs.writeFileSync(process.env.GO_ROT_TEST_IDENTITY, JSON.stringify({",
        'host: "dev.gorot.companion", protocolVersion: 1,',
        "extensionId: process.env.GO_ROT_TEST_EXTENSION_ID, pid: process.pid",
        '})); console.log("READY"); });',
        "setInterval(() => {}, 1_000);"
      ].join(" ")
    ],
    {
      env: {
        ...process.env,
        GO_ROT_TEST_SOCKET: socketPath,
        GO_ROT_TEST_IDENTITY: identityPath,
        GO_ROT_TEST_EXTENSION_ID: extensionId
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
}

function waitForReady(server) {
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    const timeout = setTimeout(() => reject(new Error("companion server did not start")), 2_000);
    server.stdout.setEncoding("utf8");
    server.stderr.setEncoding("utf8");
    server.stderr.on("data", (chunk) => {
      errorOutput += chunk;
    });
    server.stdout.on("data", (chunk) => {
      output += chunk;
      if (!output.includes("READY")) return;
      clearTimeout(timeout);
      resolve();
    });
    server.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server.once("exit", (code, signal) => {
      if (output.includes("READY")) return;
      clearTimeout(timeout);
      reject(
        new Error(
          `companion server exited early (${code ?? signal}): ${errorOutput.trim()}`
        )
      );
    });
  });
}
