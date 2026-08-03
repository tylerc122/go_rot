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
const diskImageRoot = path.join(root, "dist", ".go-rot-dmg");
const diskImageReadWrite = path.join(root, "dist", ".go-rot-layout.dmg");

fs.mkdirSync(cache, { recursive: true });
fs.rmSync(buildRoot, { recursive: true, force: true });
fs.mkdirSync(buildRoot, { recursive: true });
fs.rmSync(artifact, { force: true });
fs.rmSync(checksumArtifact, { force: true });
fs.rmSync(diskImageRoot, { recursive: true, force: true });
fs.rmSync(diskImageReadWrite, { force: true });

const runtimeArchives = prepareRuntimeArchives();
buildApplication(runtimeArchives);
signApplicationIfRequested();
buildDiskImage();
signDiskImageIfRequested();
notarizeIfRequested();
writeChecksum();
verifyOutput();
removeDiskImageIntermediates();

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

function buildDiskImage() {
  fs.mkdirSync(diskImageRoot, { recursive: true });
  run("/usr/bin/ditto", [
    application,
    path.join(diskImageRoot, `${contract.productName}.app`)
  ]);
  fs.symlinkSync("/Applications", path.join(diskImageRoot, "Applications"));
  const backgroundDirectory = path.join(diskImageRoot, ".background");
  const background = path.join(backgroundDirectory, "install-background.png");
  fs.mkdirSync(backgroundDirectory, { recursive: true });
  buildDiskImageBackground(background);
  fs.copyFileSync(
    path.join(root, "release", "macos", "GoRot.icns"),
    path.join(diskImageRoot, ".VolumeIcon.icns")
  );
  run("/usr/bin/chflags", ["hidden", backgroundDirectory]);
  run("/usr/bin/chflags", ["hidden", path.join(diskImageRoot, ".VolumeIcon.icns")]);
  run("/usr/bin/hdiutil", [
    "create",
    "-quiet",
    "-ov",
    "-fs", "HFS+",
    "-format", "UDRW",
    "-volname", contract.productName,
    "-srcfolder", diskImageRoot,
    diskImageReadWrite
  ]);
  configureDiskImageLayout();
  run("/usr/bin/hdiutil", [
    "convert",
    diskImageReadWrite,
    "-quiet",
    "-format", "UDZO",
    "-imagekey", "zlib-level=9",
    "-o", artifact
  ]);
}

function buildDiskImageBackground(destination) {
  const generator = path.join(buildRoot, ".dmg-background-generator");
  runXcrun([
    "--sdk", "macosx", "swiftc",
    path.join(root, "release", "macos", "DmgBackground.swift"),
    "-framework", "Cocoa",
    "-o", generator
  ]);
  run(generator, [destination]);
  fs.rmSync(generator, { force: true });
  const dimensions = run("/usr/bin/sips", [
    "-g", "pixelWidth",
    "-g", "pixelHeight",
    destination
  ], { capture: true });
  if (!dimensions.includes("pixelWidth: 5120") || !dimensions.includes("pixelHeight: 3200")) {
    fail("DMG background must render at 5120×3200 pixels");
  }
}

function configureDiskImageLayout() {
  const layoutScript = path.join(buildRoot, ".dmg-layout.applescript");
  let mountRoot = null;
  try {
    const attachResult = run("/usr/bin/hdiutil", [
      "attach",
      "-readwrite",
      "-noautoopen",
      "-plist",
      diskImageReadWrite
    ], { capture: true });
    mountRoot = diskImageMountPoint(attachResult);
    runXcrun(["SetFile", "-a", "C", mountRoot]);
    fs.writeFileSync(layoutScript, `
tell application "Finder"
  tell disk "${appleScriptEscape(path.basename(mountRoot))}"
    open
    set current view of container window to icon view
    set toolbar visible of container window to false
    set statusbar visible of container window to false
    set the bounds of container window to {160, 120, 880, 580}
    set viewOptions to the icon view options of container window
    set arrangement of viewOptions to not arranged
    set icon size of viewOptions to 104
    set text size of viewOptions to 14
    set shows icon preview of viewOptions to false
    set background picture of viewOptions to file ".background:install-background.png"
    set position of item "${appleScriptEscape(contract.productName)}.app" to {205, 243}
    set position of item "Applications" to {515, 243}
    update without registering applications
    delay 2
    close
  end tell
end tell
`);
    run("/usr/bin/osascript", [layoutScript]);
  } finally {
    if (mountRoot) run("/usr/bin/hdiutil", ["detach", "-quiet", mountRoot]);
    fs.rmSync(layoutScript, { force: true });
  }
}

function signDiskImageIfRequested() {
  if (!options.sign) return;
  const identity = process.env.GO_ROT_APP_SIGNING_IDENTITY;
  if (!identity) fail("GO_ROT_APP_SIGNING_IDENTITY is required with --sign");
  run("/usr/bin/codesign", [
    "--force",
    "--timestamp",
    "--sign", identity,
    artifact
  ]);
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
  run("/usr/bin/hdiutil", ["verify", artifact]);
  const mountRoot = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-dmg-mount-"));
  let diskImageProblem = null;
  try {
    run("/usr/bin/hdiutil", [
      "attach",
      "-quiet",
      "-readonly",
      "-nobrowse",
      "-noautoopen",
      "-mountpoint", mountRoot,
      artifact
    ]);
    const mountedApplication = path.join(mountRoot, `${contract.productName}.app`);
    const applicationsLink = path.join(mountRoot, "Applications");
    const background = path.join(mountRoot, ".background", "install-background.png");
    if (!fs.existsSync(path.join(mountedApplication, "Contents", "Info.plist"))) {
      diskImageProblem = "Disk image is missing Go Rot.app";
    } else if (!fs.existsSync(applicationsLink)) {
      diskImageProblem = "Disk image is missing its Applications shortcut";
    } else if (!fs.lstatSync(applicationsLink).isSymbolicLink()) {
      diskImageProblem = "Disk image Applications item is not a symbolic link";
    } else if (fs.readlinkSync(applicationsLink) !== "/Applications") {
      diskImageProblem = "Disk image Applications link has the wrong destination";
    } else if (!fs.existsSync(background)) {
      diskImageProblem = "Disk image is missing its custom install background";
    } else if (!fs.existsSync(path.join(mountRoot, ".DS_Store"))) {
      diskImageProblem = "Disk image is missing its Finder window layout";
    }
  } finally {
    run("/usr/bin/hdiutil", ["detach", "-quiet", mountRoot]);
    fs.rmSync(mountRoot, { recursive: true, force: true });
  }
  if (diskImageProblem) fail(diskImageProblem);
  if (options.sign) {
    run("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", application]);
    run("/usr/bin/codesign", ["--verify", "--verbose=2", artifact]);
  }
  if (options.notarize) {
    runXcrun(["stapler", "validate", artifact]);
    run("/usr/sbin/spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=2",
      artifact
    ]);
  }
}

function removeDiskImageIntermediates() {
  fs.rmSync(diskImageRoot, { recursive: true, force: true });
  fs.rmSync(diskImageReadWrite, { force: true });
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

function appleScriptEscape(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function diskImageMountPoint(plist) {
  const match = plist.match(/<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/);
  if (!match) fail("Could not determine the mounted DMG path");
  return match[1]
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function sourceCommit() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "not available";
}

function fail(message) {
  console.error(`Release packaging failed: ${message}`);
  process.exit(1);
}
