import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helper = path.join(root, "scripts", "codex-hook-status.mjs");

test("Codex hook status uses Codex's current trust result", (context) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-codex-trust-"));
  const home = path.join(temporary, "home");
  const hooksPath = path.join(home, ".codex", "hooks.json");
  const fakeCodex = path.join(temporary, "codex");
  fs.mkdirSync(path.dirname(hooksPath), { recursive: true });
  fs.writeFileSync(
    hooksPath,
    JSON.stringify({
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: "GO_ROT_HOOK=1 '/Applications/Go Rot.app/hook' --provider codex"
              }
            ]
          }
        ]
      }
    })
  );
  fs.writeFileSync(
    fakeCodex,
    `#!/usr/bin/env node
import readline from "node:readline";
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === 0) {
    console.log(JSON.stringify({ id: 0, result: { codexHome: "test" } }));
  }
  if (message.id === 1) {
    console.log(JSON.stringify({ id: 1, result: { data: [{
      cwd: process.env.GO_ROT_HOME,
      hooks: [{
        sourcePath: process.env.GO_ROT_FAKE_SOURCE,
        command: "GO_ROT_HOOK=1 '/Applications/Go Rot.app/hook' --provider codex",
        enabled: true,
        trustStatus: process.env.GO_ROT_FAKE_TRUST
      }]
    }] } }));
  }
});
`
  );
  fs.chmodSync(fakeCodex, 0o755);
  context.after(() => fs.rmSync(temporary, { recursive: true, force: true }));

  const run = (trustStatus) =>
    spawnSync(process.execPath, [helper], {
      encoding: "utf8",
      env: {
        ...process.env,
        GO_ROT_HOME: home,
        GO_ROT_CODEX_CLI: fakeCodex,
        GO_ROT_FAKE_SOURCE: hooksPath,
        GO_ROT_FAKE_TRUST: trustStatus
      }
    });

  const trusted = run("trusted");
  assert.equal(trusted.status, 0, trusted.stderr);
  assert.equal(JSON.parse(trusted.stdout).trusted, true);

  const changed = run("changed");
  assert.equal(changed.status, 2, changed.stderr);
  assert.deepEqual(JSON.parse(changed.stdout), {
    installed: true,
    trusted: false,
    reason: "approval_required",
    expected: 1,
    discovered: 1
  });
});

