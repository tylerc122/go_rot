#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") fail("Release packaging supports macOS only.");

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const contract = readJson(path.join(root, "release", "release-contract.json"));
const options = parseOptions(process.argv.slice(2));
const cache = path.resolve(options.cache ?? path.join(root, ".release-cache", "runtimes"));
const buildRoot = path.join(root, "dist", "release");
const application = path.join(buildRoot, `${contract.productName}.app`);
const artifact = path.join(root, "dist", contract.delivery.artifactName);
const checksumArtifact = `${artifact}.sha256`;
const componentPackage = path.join(root, "dist", ".go-rot-component.pkg");
const componentPlist = path.join(root, "dist", ".go-rot-components.plist");

fs.mkdirSync(cache, { recursive: true });
fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(buildRoot, { recursive: true });
fs.rmSync(artifact, { force: true });
fs.rmSync(checksumArtifact, { force: true });
fs.rmSync(componentPackage, { recursive: true, force: true });
fs.rmSync(componentPlist, { force: true });

const runtimeArchives = prepareRuntimeArchives();
buildApplication(runtimeArchives);
signApplicationIfRequested();
buildPackage();
notarizeIfRequested();
writeChecksum();
verifyOutput();
removePackageIntermediates();

console.log(`Created ${application}`);
console.log(`Created ${artifact}`);
console.log(`Created ${checksumArtifact}`);
if (!options.sign) {
  console.log("Unsigned dry run: pass --sign after Developer ID identities are installed.");
}

function prepareRuntimeArchives() {
  return Object.fromEntries(
    Object.entries(contract.runtime.archives).map(([architecture, runtime]) => {
      const archive = path.join(cache, runtime.file);
      if (!fs.existsSync(archive)) {
        if (options.offline) fail(`Missing cached runtime: ${archive}`);
        run("/usr/bin/curl", ["-fL", `${contract.runtime.baseUrl}/${runtime.file}`, "-o", archive]);
      }
      const actual = sha256(archive);
      if (actual !== runtime.sha256) {
        fail(`Checksum mismatch for ${runtime.file}: expected ${runtime.sha256}, got ${actual}`);
      }
      return [architecture, archive];
    })
  );
}

function buildApplication(archives) {
  const contents = path.join(application, "Contents");
  const macos = path.join(contents, "MacOS");
  const resources = path.join(contents, "Resources");
  const frameworks = path.join(contents, "Frameworks", "node");
  fs.mkdirSync(macos, { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(frameworks, { recursive: true });

  compileUniversalSwift(path.join(macos, contract.executables.application));
  const toolLauncher = path.join(macos, ".go-rot-tool-launcher");
  compileUniversalC(toolLauncher);
  for (const name of [
    contract.executables.nativeHost,
    contract.executables.doctor,
    contract.executables.uninstaller
  ]) {
    fs.copyFileSync(toolLauncher, path.join(macos, name));
    fs.chmodSync(path.join(macos, name), 0o755);
  }
  fs.rmSync(toolLauncher);

  for (const [architecture, archive] of Object.entries(archives)) {
    const extraction = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-node-"));
    try {
      run("/usr/bin/tar", ["-xzf", archive, "-C", extraction]);
      const extractedRoot = fs.readdirSync(extraction).map((name) => path.join(extraction, name))
        .find((candidate) => fs.statSync(candidate).isDirectory());
      if (!extractedRoot) fail(`Could not extract ${path.basename(archive)}`);
      const source = path.join(extractedRoot, "bin", "node");
      const destination = path.join(frameworks, architecture, "bin", "node");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o755);
    } finally {
      fs.rmSync(extraction, { recursive: true, force: true });
    }
  }

  const appResources = path.join(resources, "app");
  for (const relative of ["bin", "companion", "extension", "integrations"]) {
    fs.cpSync(path.join(root, relative), path.join(appResources, relative), { recursive: true });
  }
  for (const relative of [
    "scripts/install.mjs",
    "scripts/doctor.mjs",
    "scripts/codex-hook-status.mjs",
    "package.json"
  ]) {
    const destination = path.join(appResources, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(root, relative), destination);
  }
  fs.mkdirSync(path.join(appResources, "release"), { recursive: true });
  fs.copyFileSync(
    path.join(root, "release", "release-contract.json"),
    path.join(appResources, "release", "release-contract.json")
  );

  writeInfoPlist(path.join(contents, "Info.plist"));
  buildIcon(path.join(resources, "GoRot.icns"));
  fs.writeFileSync(
    path.join(resources, "BUILD_INFO.json"),
    `${JSON.stringify({
      product: contract.productName,
      version: contract.version,
      sourceCommit: sourceCommit(),
      builtAt: new Date().toISOString(),
      signed: options.sign,
      runtime: contract.runtime
    }, null, 2)}\n`
  );
  run("/usr/bin/xattr", ["-cr", application]);
}

function compileUniversalSwift(output) {
  const source = path.join(root, "release", "macos", "GoRotApp.swift");
  compileSlices("swiftc", source, output, [
    "-framework",
    "Cocoa",
    "-framework",
    "UserNotifications"
  ]);
}

function compileUniversalC(output) {
  const source = path.join(root, "release", "macos", "tool-launcher.c");
  compileSlices("clang", source, output, []);
}

function compileSlices(compiler, source, output, trailing) {
  const slices = [];
  for (const architecture of contract.delivery.architectures) {
    const slice = path.join(buildRoot, `.slice-${path.basename(output)}-${architecture}`);
    const target = `${architecture}-apple-macosx${contract.delivery.minimumMacOS}`;
    runXcrun(["--sdk", "macosx", compiler, source, "-target", target, ...trailing, "-o", slice]);
    slices.push(slice);
  }
  runXcrun(["lipo", "-create", ...slices, "-output", output]);
  fs.chmodSync(output, 0o755);
  for (const slice of slices) fs.rmSync(slice, { force: true });
}

function writeInfoPlist(destination) {
  fs.writeFileSync(destination, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleDevelopmentRegion</key><string>en</string>
<key>CFBundleDisplayName</key><string>${contract.productName}</string>
<key>CFBundleExecutable</key><string>${contract.executables.application}</string>
<key>CFBundleIconFile</key><string>GoRot</string>
<key>CFBundleIdentifier</key><string>${contract.identifiers.appBundle}</string>
<key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
<key>CFBundleName</key><string>${contract.productName}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${contract.version}</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSMinimumSystemVersion</key><string>${contract.delivery.minimumMacOS}</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSHumanReadableCopyright</key><string>Copyright © 2026 Go Rot contributors</string>
</dict></plist>\n`);
}

function buildIcon(destination) {
  fs.copyFileSync(path.join(root, "release", "macos", "GoRot.icns"), destination);
}

function signApplicationIfRequested() {
  if (!options.sign) return;
  const identity = process.env.GO_ROT_APP_SIGNING_IDENTITY;
  if (!identity) fail("GO_ROT_APP_SIGNING_IDENTITY is required with --sign");
  const contents = path.join(application, "Contents");
  const entitlements = path.join(root, "release", "macos", "node-entitlements.plist");
  for (const architecture of contract.delivery.architectures) {
    run("/usr/bin/codesign", ["--force", "--timestamp", "--options", "runtime", "--entitlements", entitlements, "--sign", identity, path.join(contents, "Frameworks", "node", architecture, "bin", "node")]);
  }
  for (const executable of [
    contract.executables.nativeHost,
    contract.executables.doctor,
    contract.executables.uninstaller,
    contract.executables.application
  ]) {
    run("/usr/bin/codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, path.join(contents, "MacOS", executable)]);
  }
  run("/usr/bin/codesign", ["--force", "--timestamp", "--options", "runtime", "--sign", identity, application]);
}

function buildPackage() {
  writeComponentPlist();
  run(
    "/usr/bin/pkgbuild",
    [
      "--root", buildRoot,
      "--component-plist", componentPlist,
      "--identifier", contract.identifiers.appBundle,
      "--version", contract.version,
      "--install-location", "/Applications",
      componentPackage
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" } }
  );

  const args = [];
  if (options.sign) {
    const identity = process.env.GO_ROT_INSTALLER_SIGNING_IDENTITY;
    if (!identity) fail("GO_ROT_INSTALLER_SIGNING_IDENTITY is required with --sign");
    args.push("--sign", identity);
  }
  args.push(
    "--identifier", contract.identifiers.installerPackage,
    "--version", contract.version,
    "--package", componentPackage,
    artifact
  );
  run("/usr/bin/productbuild", args, {
    env: { ...process.env, COPYFILE_DISABLE: "1" }
  });
}

function writeComponentPlist() {
  fs.writeFileSync(componentPlist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><array><dict>
<key>RootRelativeBundlePath</key><string>${xmlEscape(contract.productName)}.app</string>
<key>BundleIsRelocatable</key><false/>
<key>BundleIsVersionChecked</key><false/>
<key>BundleHasStrictIdentifier</key><true/>
<key>BundleOverwriteAction</key><string>upgrade</string>
</dict></array></plist>
`);
}

function notarizeIfRequested() {
  if (!options.notarize) return;
  if (!options.sign) fail("--notarize requires --sign");
  const profile = process.env.GO_ROT_NOTARY_PROFILE;
  if (!profile) fail("GO_ROT_NOTARY_PROFILE is required with --notarize");
  runXcrun(["notarytool", "submit", artifact, "--keychain-profile", profile, "--wait"]);
  runXcrun(["stapler", "staple", artifact]);
}

function writeChecksum() {
  fs.writeFileSync(checksumArtifact, `${sha256(artifact)}  ${path.basename(artifact)}\n`);
}

function verifyOutput() {
  run("/usr/bin/plutil", ["-lint", path.join(application, "Contents", "Info.plist")]);
  run("/usr/bin/xcrun", [
    "lipo",
    path.join(application, "Contents", "MacOS", contract.executables.application),
    "-verify_arch",
    ...contract.delivery.architectures
  ]);
  for (const architecture of contract.delivery.architectures) {
    const runtime = path.join(application, "Contents", "Frameworks", "node", architecture, "bin", "node");
    const result = run(runtime, ["--version"], { capture: true });
    if (result.trim() !== `v${contract.runtime.version}`) fail(`Wrong bundled runtime for ${architecture}`);
  }
  run("/usr/sbin/pkgutil", ["--payload-files", artifact], { capture: true });
  const expansionRoot = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-component-"));
  const expanded = path.join(expansionRoot, "expanded");
  try {
    run("/usr/sbin/pkgutil", ["--expand", componentPackage, expanded], {
      capture: true
    });
    const packageInfo = fs.readFileSync(path.join(expanded, "PackageInfo"), "utf8");
    if (!packageInfo.includes('relocatable="false"')) {
      fail("Component package permits app relocation outside /Applications");
    }
  } finally {
    fs.rmSync(expansionRoot, { recursive: true, force: true });
  }
  if (options.sign) {
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]);
    run("/usr/sbin/pkgutil", ["--check-signature", artifact]);
  }
  if (options.notarize) {
    runXcrun(["stapler", "validate", artifact]);
    run("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "install",
      "--verbose=2",
      artifact
    ]);
  }
}

function removePackageIntermediates() {
  fs.rmSync(componentPackage, { recursive: true, force: true });
  fs.rmSync(componentPlist, { force: true });
}

function parseOptions(args) {
  const parsed = { sign: false, notarize: false, offline: false, cache: null };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--sign") parsed.sign = true;
    else if (args[index] === "--notarize") parsed.notarize = true;
    else if (args[index] === "--offline") parsed.offline = true;
    else if (args[index] === "--cache" && args[index + 1]) parsed.cache = args[++index];
    else fail("Usage: node scripts/package-release.mjs [--offline] [--cache PATH] [--sign] [--notarize]");
  }
  return parsed;
}

function runXcrun(args) {
  const moduleCache = path.join(root, ".release-cache", "module-cache");
  fs.mkdirSync(moduleCache, { recursive: true });
  return run("/usr/bin/xcrun", args, {
    env: {
      ...process.env,
      DEVELOPER_DIR: "/Applications/Xcode.app/Contents/Developer",
      CLANG_MODULE_CACHE_PATH: moduleCache,
      SWIFT_MODULE_CACHE_PATH: moduleCache
    }
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
    env: options.env ?? process.env
  });
  if (result.status !== 0) fail(result.stderr?.trim() || `${path.basename(command)} failed`);
  return options.capture ? result.stdout : "";
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function sourceCommit() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "not available";
}

function fail(message) {
  console.error(`Release packaging failed: ${message}`);
  process.exit(1);
}
