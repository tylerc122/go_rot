#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { NativeMessageDecoder } from "../companion/native-framing.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-bench-"));
const environment = {
  ...process.env,
  GO_ROT_RUNTIME_DIR: runtime,
  GO_ROT_SOURCE_APP: "Terminal"
};
const host = spawn(
  process.execPath,
  [path.join(root, "companion", "native-host.mjs")],
  {
    cwd: root,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"]
  }
);
const decoder = new NativeMessageDecoder();
const messages = [];
host.stdout.on("data", (chunk) => messages.push(...decoder.push(chunk)));

try {
  await waitFor(() => messages.some((message) => message.type === "companion.ready"));

  const timings = [];
  for (let index = 0; index < 20; index += 1) {
    const startedAt = performance.now();
    await runHook(index);
    timings.push(performance.now() - startedAt);
  }

  timings.sort((a, b) => a - b);
  const median = percentile(timings, 0.5);
  const p95 = percentile(timings, 0.95);
  console.log(`Hook latency median: ${median.toFixed(1)} ms`);
  console.log(`Hook latency p95: ${p95.toFixed(1)} ms`);
  if (p95 > 100) {
    console.error("Hook latency exceeds the 100 ms target.");
    process.exitCode = 1;
  }
} finally {
  host.kill("SIGTERM");
}

function runHook(index) {
  return new Promise((resolve, reject) => {
    const hook = spawn(
      process.execPath,
      [
        path.join(root, "bin", "go-rot-hook.mjs"),
        "--provider",
        "codex",
        "--surface",
        "cli"
      ],
      {
        cwd: root,
        env: environment,
        stdio: ["pipe", "ignore", "pipe"]
      }
    );
    let errorText = "";
    hook.stderr.setEncoding("utf8");
    hook.stderr.on("data", (chunk) => {
      errorText += chunk;
    });
    hook.once("error", reject);
    hook.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorText || `Hook exited ${code}`));
    });
    hook.stdin.end(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "benchmark",
        turn_id: `turn-${index}`
      })
    );
  });
}

function percentile(values, fraction) {
  return values[Math.min(values.length - 1, Math.ceil(values.length * fraction) - 1)];
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out starting benchmark companion.");
}
