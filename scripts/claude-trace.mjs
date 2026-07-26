#!/usr/bin/env node

import fs from "node:fs";
import { statePath } from "../companion/constants.mjs";

let state;
try {
  state = JSON.parse(fs.readFileSync(statePath(), "utf8"));
} catch {
  process.stderr.write("No FirstTok lifecycle trace is available yet.\n");
  process.exit(1);
}

const events = (state.recentLifecycle ?? []).filter(
  (event) => event.agent === "claude-code" || event.agent === "system"
);
if (events.length === 0) {
  process.stderr.write("No recent Claude lifecycle events are available.\n");
  process.exit(1);
}

for (const event of events) {
  const timestamp = new Date(event.timestamp).toISOString();
  const details = [
    event.sequence ? `seq=${event.sequence}` : null,
    event.prompt ? `prompt=${event.prompt}` : null,
    event.querySource ? `source=${event.querySource}` : null
  ]
    .filter(Boolean)
    .join(" ");
  process.stdout.write(
    `${timestamp}  ${event.session}  ${event.source.padEnd(10)}  ${event.type}${details ? `  ${details}` : ""}\n`
  );
}
