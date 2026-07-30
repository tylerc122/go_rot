#!/usr/bin/env node

import net from "node:net";
import {
  detectSourceApp,
  detectSurface,
  lifecycleEventFromHook
} from "../companion/protocol.mjs";
import { socketPath } from "../companion/constants.mjs";

const options = parseArguments(process.argv.slice(2));
const input = await readStandardInput();
const surface =
  options.surface ?? detectSurface(options.agent, process.env, input);
const sourceApp = detectSourceApp(options.agent, surface);
const event = lifecycleEventFromHook(input, {
  agent: options.agent,
  surface,
  sourceApp
});

if (event) {
  await sendEvent(event);
}

function parseArguments(args) {
  const parsed = { agent: null, surface: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--provider") parsed.agent = args[++index];
    if (args[index] === "--surface") parsed.surface = args[++index];
  }
  if (!["claude-code", "codex"].includes(parsed.agent)) {
    throw new Error("--provider must be claude-code or codex");
  }
  if (parsed.surface && !["cli", "desktop"].includes(parsed.surface)) {
    throw new Error("--surface must be cli or desktop");
  }
  return parsed;
}

async function readStandardInput() {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  if (!input.trim()) return {};
  try {
    return JSON.parse(input);
  } catch {
    return {};
  }
}

async function sendEvent(event) {
  await new Promise((resolve) => {
    const client = net.createConnection(socketPath());
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (!client.destroyed) client.destroy();
      resolve();
    };
    const timeout = setTimeout(() => {
      client.destroy();
      finish();
    }, 75);

    client.once("connect", () => {
      client.end(`${JSON.stringify(event)}\n`);
    });
    client.once("data", finish);
    client.once("close", finish);
    client.once("error", finish);
  });
}
