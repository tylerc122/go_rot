import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { NativeMessageDecoder } from "../companion/native-framing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("doctor distinguishes installation, hook approval, and live companion state", async (t) => {
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-doctor-"));
  const runtime = fs.mkdtempSync(
    path.join(os.tmpdir(), "firsttok-doctor-runtime-")
  );
  run(
    [path.join(root, "scripts", "install.mjs"), "install", "--all"],
    target,
    runtime
  );

  const waiting = run(
    [path.join(root, "scripts", "doctor.mjs")],
    target,
    runtime
  );
  assert.match(waiting.stdout, /PASS\s+Chrome-safe native host launcher/);
  assert.match(waiting.stdout, /WAIT\s+Companion connection/);
  assert.match(waiting.stdout, /ACTION\s+Codex hook approval/);
  assert.match(waiting.stdout, /enter "\/hooks"/);
  assert.match(waiting.stdout, /NEXT\s+Open chrome:\/\/extensions/);

  const host = spawn(
    process.execPath,
    [path.join(root, "companion", "native-host.mjs")],
    {
    cwd: root,
    env: {
      ...process.env,
      FIRSTTOK_RUNTIME_DIR: runtime
    },
    stdio: ["pipe", "pipe", "pipe"]
    }
  );
  t.after(() => host.kill("SIGTERM"));

  const decoder = new NativeMessageDecoder();
  const messages = [];
  host.stdout.on("data", (chunk) => messages.push(...decoder.push(chunk)));
  await waitFor(() =>
    messages.some((message) => message.type === "companion.ready")
  );

  const connected = run(
    [path.join(root, "scripts", "doctor.mjs")],
    target,
    runtime
  );
  assert.match(connected.stdout, /PASS\s+Companion connection/);
  assert.doesNotMatch(connected.stdout, /NEXT\s+Open chrome:\/\/extensions/);
});

function run(args, home, runtime) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: {
      ...process.env,
      FIRSTTOK_HOME: home,
      FIRSTTOK_RUNTIME_DIR: runtime
    },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for condition.");
}
