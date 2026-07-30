#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const contract = JSON.parse(
  fs.readFileSync(path.join(root, "release", "release-contract.json"), "utf8")
);
const artifact = path.join(
  root,
  "dist",
  `${contract.artifactSlug}-chrome-v${contract.version}.zip`
);
const checksum = `${artifact}.sha256`;
const stagingRoot = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-extension-"));
const stagedExtension = path.join(stagingRoot, "extension");

run(process.execPath, [path.join(root, "scripts", "validate-extension.mjs")]);
try {
  fs.cpSync(extensionRoot, stagedExtension, { recursive: true });
  const storeManifestPath = path.join(stagedExtension, "manifest.json");
  const storeManifest = JSON.parse(fs.readFileSync(storeManifestPath, "utf8"));
  delete storeManifest.key;
  fs.writeFileSync(storeManifestPath, `${JSON.stringify(storeManifest, null, 2)}\n`);

  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  fs.rmSync(artifact, { force: true });
  fs.rmSync(checksum, { force: true });
  run(
    "/usr/bin/zip",
    ["-X", "-q", "-r", artifact, ".", "-x", "*.DS_Store", "-x", "__MACOSX/*"],
    { cwd: stagedExtension }
  );
} finally {
  fs.rmSync(stagingRoot, { recursive: true, force: true });
}

const listing = spawnSync("/usr/bin/unzip", ["-Z1", artifact], {
  encoding: "utf8"
});
if (listing.status !== 0) fail(listing.stderr.trim() || "Could not inspect extension archive.");
const files = listing.stdout.trim().split("\n");
if (!files.includes("manifest.json")) fail("manifest.json must be at the archive root.");
if (files.some((name) => name.startsWith("extension/"))) {
  fail("Extension archive contains an extra top-level directory.");
}
const archivedManifestResult = spawnSync(
  "/usr/bin/unzip",
  ["-p", artifact, "manifest.json"],
  { encoding: "utf8" }
);
if (archivedManifestResult.status !== 0) fail("Could not read archived manifest.json.");
const archivedManifest = JSON.parse(archivedManifestResult.stdout);
if ("key" in archivedManifest) fail("Chrome Web Store archive must not contain manifest.key.");

const digest = crypto.createHash("sha256").update(fs.readFileSync(artifact)).digest("hex");
fs.writeFileSync(checksum, `${digest}  ${path.basename(artifact)}\n`);
console.log(`Created ${artifact}`);
console.log(`Created ${checksum}`);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: "inherit",
    env: { ...process.env, COPYFILE_DISABLE: "1" }
  });
  if (result.status !== 0) fail(`${path.basename(command)} failed.`);
}

function fail(message) {
  console.error(`Extension packaging failed: ${message}`);
  process.exit(1);
}
