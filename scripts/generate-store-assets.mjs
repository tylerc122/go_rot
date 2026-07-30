#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

if (process.platform !== "darwin") fail("Store artwork generation supports macOS only.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const source = path.join(root, "release", "chrome-store", "store-art.html");
const output = path.join(root, "release", "chrome-store", "assets");
const requestedAsset = parseAsset(process.argv.slice(2));
const assets = [
  ["screenshot-panel", 1280, 800, "screenshot-panel-1280x800.png"],
  ["screenshot-demo", 1280, 800, "screenshot-demo-1280x800.png"],
  ["promo-small", 440, 280, "promo-small-440x280.png"],
  ["promo-marquee", 1400, 560, "promo-marquee-1400x560.png"]
].filter(([asset]) => !requestedAsset || asset === requestedAsset);

if (!fs.existsSync(chrome)) fail("Google Chrome is required to render store artwork.");
fs.mkdirSync(output, { recursive: true });
for (const [asset, width, height, name] of assets) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-store-art-"));
  try {
    const destination = path.join(output, name);
    fs.rmSync(destination, { force: true });
    const url = `${pathToFileURL(source)}?asset=${asset}`;
    const result = spawnSync(
      chrome,
      [
        "--headless=new",
        "--disable-gpu",
        "--disable-crash-reporter",
        "--disable-background-networking",
        "--disable-component-update",
        "--no-first-run",
        "--no-default-browser-check",
        "--hide-scrollbars",
        "--allow-file-access-from-files",
        "--virtual-time-budget=1200",
        `--user-data-dir=${profile}`,
        `--window-size=${width},${height}`,
        `--screenshot=${destination}`,
        url
      ],
      { encoding: "utf8", timeout: 10_000, killSignal: "SIGKILL" }
    );
    if (!fs.existsSync(destination)) {
      fail(result.stderr.trim() || result.stdout.trim() || `Could not render ${name}`);
    }
    console.log(`Created ${destination}`);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

function parseAsset(args) {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === "--asset") return args[1];
  fail("Usage: node scripts/generate-store-assets.mjs [--asset NAME]");
}

function fail(message) {
  console.error(`Store artwork generation failed: ${message}`);
  process.exit(1);
}
