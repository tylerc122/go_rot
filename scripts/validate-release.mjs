#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = readJson("release/release-contract.json");
const packageJson = readJson("package.json");
const manifest = readJson("extension/manifest.json");
const constants = fs.readFileSync(path.join(root, "companion/constants.mjs"), "utf8");
const serviceWorker = fs.readFileSync(
  path.join(root, "extension/service-worker.mjs"),
  "utf8"
);
const errors = [];

expect(contract.productName === "Go Rot", "public product name must be Go Rot");
expect(contract.version === packageJson.version, "package version differs from release contract");
expect(contract.version === manifest.version, "extension version differs from release contract");
expect(
  contract.delivery.artifactName ===
    `${contract.artifactSlug}-macos-v${contract.version}.pkg`,
  "production artifact name differs from release contract"
);
expect(contract.delivery.bundleRuntime === true, "production package must bundle its runtime");
expect(
  sameValues(contract.delivery.architectures, ["arm64", "x86_64"]),
  "production package must support arm64 and x86_64"
);
expect(contract.runtime.name === "node", "production runtime must be Node.js");
expect(
  Number(contract.runtime.version.split(".")[0]) >= 24,
  "production runtime must use a supported Node.js release"
);
for (const architecture of contract.delivery.architectures) {
  const runtime = contract.runtime.archives?.[architecture];
  expect(Boolean(runtime?.file), `missing ${architecture} runtime archive`);
  expect(
    /^[a-f0-9]{64}$/.test(runtime?.sha256 ?? ""),
    `missing ${architecture} runtime checksum`
  );
}
expect(
  contract.identifiers.chromeExtensionDevelopment === extensionId(manifest.key),
  "extension key does not produce the frozen development extension ID"
);
expect(
  /^[a-p]{32}$/.test(contract.identifiers.chromeExtension),
  "production Chrome Web Store ID must contain 32 letters from a-p"
);
expect(
  constants.includes(
    `NATIVE_HOST_NAME = "${contract.identifiers.nativeMessagingHost}"`
  ),
  "companion native-host identifier differs from release contract"
);
expect(
  serviceWorker.includes(
    `NATIVE_HOST = "${contract.identifiers.nativeMessagingHost}"`
  ),
  "extension native-host identifier differs from release contract"
);
expect(
  contract.installLocations.nativeHostManifest.endsWith(
    `/${contract.identifiers.nativeMessagingHost}.json`
  ),
  "native-host manifest path does not match its identifier"
);
expect(
  contract.identifiers.appBundle === "dev.gorot.app" &&
    contract.identifiers.installerPackage === "dev.gorot.pkg" &&
    contract.identifiers.nativeMessagingHost === "dev.gorot.companion",
  "release identifiers must use the gorot.dev namespace"
);
for (const relativePath of [
  "release/macos/GoRotApp.swift",
  "release/macos/tool-launcher.c",
  "release/macos/node-entitlements.plist",
  "release/macos/GoRot.icns",
  "scripts/package-release.mjs"
]) {
  expect(fs.existsSync(path.join(root, relativePath)), `missing release input: ${relativePath}`);
}

if (errors.length > 0) {
  console.error("Release contract validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Release contract validation passed: ${contract.productName} ${contract.version}`
);

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function extensionId(key) {
  const digest = crypto
    .createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest();
  return [...digest.subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join("");
}

function sameValues(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((value) => actual.includes(value))
  );
}

function expect(condition, message) {
  if (!condition) errors.push(message);
}
