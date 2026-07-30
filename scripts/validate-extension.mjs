#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(root, "extension");
const manifest = readJson(path.join(extensionRoot, "manifest.json"));
const contract = readJson(path.join(root, "release", "release-contract.json"));
const errors = [];

expect(manifest.manifest_version === 3, "manifest_version must be 3");
expect(manifest.background?.service_worker === "service-worker.mjs", "service worker is missing");
expect(manifest.action?.default_popup === "panel.html", "toolbar popup is missing");
expect(manifest.permissions?.includes("nativeMessaging"), "nativeMessaging permission is missing");
expect(manifest.permissions?.includes("storage"), "storage permission is missing");
expect(manifest.permissions?.includes("scripting"), "scripting permission is missing");
expect(
  manifest.permissions?.includes("system.display"),
  "system.display permission is missing"
);
expect(!manifest.host_permissions, "host_permissions are not allowed");
expect(!manifest.content_scripts, "content scripts are not allowed");
expect(
  JSON.stringify(manifest.optional_host_permissions) ===
    JSON.stringify([
      "https://www.youtube.com/*",
      "https://www.tiktok.com/*",
      "https://www.instagram.com/*"
    ]),
  "optional host permissions must stay limited to supported feeds"
);

for (const relativePath of referencedFiles(manifest)) {
  expect(
    fs.existsSync(path.join(extensionRoot, relativePath)),
    `referenced extension file is missing: ${relativePath}`
  );
}

for (const [size, relativePath] of Object.entries(manifest.icons ?? {})) {
  const dimensions = pngDimensions(path.join(extensionRoot, relativePath));
  expect(
    dimensions?.width === Number(size) && dimensions?.height === Number(size),
    `${relativePath} must be ${size}x${size}`
  );
}

const extensionId = idFromKey(manifest.key);
expect(
  extensionId === contract.identifiers.chromeExtensionDevelopment,
  "extension key changed its stable development ID"
);
expect(
  /^[a-p]{32}$/.test(contract.identifiers.chromeExtension),
  "production Chrome Web Store ID must contain 32 letters from a-p"
);

if (errors.length > 0) {
  console.error("Extension validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Extension validation passed: development ${extensionId}; production ${contract.identifiers.chromeExtension}`
);

function referencedFiles(value, key = "") {
  if (typeof value === "string") {
    if (
      ["service_worker", "default_popup", "page", "default_icon", "icons"].includes(
        key
      ) ||
      /\.(?:html|mjs|js|png|css)$/.test(value)
    ) {
      return [value];
    }
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => referencedFiles(item, key));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([childKey, child]) =>
      referencedFiles(child, childKey)
    );
  }
  return [];
}

function pngDimensions(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    if (buffer.toString("ascii", 1, 4) !== "PNG") return null;
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20)
    };
  } catch {
    return null;
  }
}

function idFromKey(key) {
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest();
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join("");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function expect(condition, message) {
  if (!condition) errors.push(message);
}
