#!/usr/bin/env node

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
const outputDirectory = path.join(root, "dist");
const output = path.join(
  outputDirectory,
  `firsttok-macos-alpha-v${packageJson.version}.zip`
);
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "firsttok-package-"));
const bundle = path.join(temporary, "firsttok");
const included = [
  "bin",
  "companion",
  "docs",
  "extension",
  "integrations",
  "scripts",
  "test",
  "DESIGN.md",
  "MVP_AUDIT.md",
  "PRODUCT.md",
  "README.md",
  "package.json",
  "spec.md"
];

try {
  fs.mkdirSync(bundle, { recursive: true });
  for (const relativePath of included) {
    const source = path.join(root, relativePath);
    if (!fs.existsSync(source)) continue;
    fs.cpSync(source, path.join(bundle, relativePath), { recursive: true });
  }
  fs.copyFileSync(
    path.join(root, "docs", "friend-alpha.md"),
    path.join(bundle, "START_HERE.md")
  );
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.rmSync(output, { force: true });

  const result = spawnSync(
    "/usr/bin/ditto",
    ["-c", "-k", "--norsrc", "--keepParent", bundle, output],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    fail(result.stderr.trim() || "Could not create the alpha archive.");
  }
  console.log(`Created ${output}`);
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
