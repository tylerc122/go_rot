#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  fail("Alpha packaging currently supports macOS only.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);
const surface = parseSurface(process.argv.slice(2));
const archiveLabel = surface === "claude" ? "claude-alpha" : "alpha";
const outputDirectory = path.join(root, "dist");
const output = path.join(
  outputDirectory,
  `firsttok-macos-${archiveLabel}-v${packageJson.version}.zip`
);
const checksumOutput = `${output}.sha256`;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-package-"));
const bundle = path.join(temporary, "firsttok");
const included = [
  "bin",
  "companion",
  "extension",
  "integrations",
  "scripts",
  "test",
  "package.json"
];

try {
  fs.mkdirSync(bundle, { recursive: true });
  for (const relativePath of included) {
    const source = path.join(root, relativePath);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(bundle, relativePath), { recursive: true });
  }
  const startGuide =
    surface === "claude"
      ? path.join(root, "docs", "claude-friend-alpha.md")
      : path.join(root, "docs", "friend-alpha.md");
  fs.copyFileSync(
    startGuide,
    path.join(bundle, "START_HERE.md")
  );
  fs.copyFileSync(
    path.join(
      root,
      "docs",
      surface === "claude"
        ? "claude-alpha-results.md"
        : "friend-alpha-results.md"
    ),
    path.join(bundle, "RESULTS.md")
  );
  fs.writeFileSync(
    path.join(bundle, "ALPHA_BUILD.txt"),
    [
      `FirstTok version: ${packageJson.version}`,
      `Package: ${surface === "claude" ? "Claude friend alpha" : "general friend alpha"}`,
      `Source commit: ${sourceCommit()}`,
      `Source state: ${sourceState()}`,
      `Built: ${new Date().toISOString()}`,
      ""
    ].join("\n")
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.rmSync(output, { force: true });
  fs.rmSync(checksumOutput, { force: true });

  const result = spawnSync(
    "/usr/bin/ditto",
    ["-c", "-k", "--norsrc", "--keepParent", bundle, output],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    fail(result.stderr.trim() || "Could not create the alpha archive.");
  }
  const checksum = crypto
    .createHash("sha256")
    .update(fs.readFileSync(output))
    .digest("hex");
  fs.writeFileSync(
    checksumOutput,
    `${checksum}  ${path.basename(output)}\n`
  );
  console.log(`Created ${output}`);
  console.log(`Created ${checksumOutput}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function parseSurface(args) {
  if (args.length === 0) return "all";
  if (args.length === 2 && args[0] === "--surface" && args[1] === "claude") {
    return "claude";
  }
  fail("Usage: node scripts/package-alpha.mjs [--surface claude]");
}

function sourceCommit() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() : "not available";
}

function sourceState() {
  const result = spawnSync("git", ["status", "--porcelain"], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) return "not available";
  return result.stdout.trim() ? "uncommitted changes included" : "clean";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
