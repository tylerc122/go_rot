#!/usr/bin/env node

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  claudeOtelEnvironment,
  createClaudeOtelConfig
} from "../companion/claude-otel-config.mjs";
import { startClaudeOtelReceiver } from "../companion/claude-otel-receiver.mjs";

const { claudeArgs, outputPath } = parseArguments(process.argv.slice(2));
const config = createClaudeOtelConfig(await availablePort());
const output = path.resolve(
  outputPath ??
    path.join(
      os.tmpdir(),
      `firsttok-claude-events-${new Date().toISOString().replaceAll(":", "-")}.jsonl`
    )
);
const temporaryDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "firsttok-claude-capture-")
);
const settingsPath = path.join(temporaryDirectory, "settings.json");
const environment = claudeOtelEnvironment(config);

fs.writeFileSync(
  settingsPath,
  `${JSON.stringify({ env: environment }, null, 2)}\n`,
  { mode: 0o600 }
);
fs.writeFileSync(output, "", { mode: 0o600 });

const receiver = await startClaudeOtelReceiver({
  config,
  onDecision: () => {},
  onEvent(event) {
    fs.appendFileSync(output, `${JSON.stringify(event)}\n`);
    process.stderr.write(
      `[Go Rot event] ${event.sequence} ${event.eventName}\n`
    );
  }
});

process.stderr.write(`Go Rot event capture: ${output}\n`);
process.stderr.write(
  "Prompt, response, tool details, tool content, and raw API bodies are disabled.\n"
);

const claude = spawn(
  "claude",
  [
    "--settings",
    settingsPath,
    "--permission-mode",
    "manual",
    "--ax-screen-reader",
    ...claudeArgs
  ],
  {
    env: { ...process.env, ...environment },
    stdio: "inherit"
  }
);

const exitCode = await new Promise((resolve) => {
  claude.once("error", (error) => {
    process.stderr.write(`Could not start Claude: ${error.message}\n`);
    resolve(1);
  });
  claude.once("exit", (code, signal) => {
    resolve(Number.isInteger(code) ? code : signal ? 1 : 0);
  });
});

await receiver.close();
fs.rmSync(temporaryDirectory, { recursive: true, force: true });
process.stderr.write(`Go Rot event capture complete: ${output}\n`);
process.exitCode = exitCode;

function parseArguments(args) {
  const claudeArgs = [];
  let outputPath = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output") {
      outputPath = args[++index];
      if (!outputPath) fail("--output requires a file path.");
      continue;
    }
    claudeArgs.push(args[index]);
  }
  return { claudeArgs, outputPath };
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (Number.isInteger(port)) resolve(port);
        else reject(new Error("Could not allocate a local capture port."));
      });
    });
  });
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
