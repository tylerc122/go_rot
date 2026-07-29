#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  fail("Packaging currently supports macOS only.");
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  fs.readFileSync(path.join(root, "package.json"), "utf8")
);
const options = parseOptions(process.argv.slice(2));
const archiveLabel = options.demo
  ? "preview"
  : options.surface === "claude"
    ? "claude-alpha"
    : "alpha";
const outputDirectory = path.join(root, "dist");
const output = path.join(
  outputDirectory,
  `go-rot-macos-${archiveLabel}-v${packageJson.version}.zip`
);
const checksumOutput = `${output}.sha256`;
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "go-rot-package-"));
const bundle = path.join(temporary, "go-rot");
const productSources = [
  "bin",
  "companion",
  "extension",
  "integrations",
  "scripts/install.mjs",
  "scripts/doctor.mjs",
  "package.json"
];
const included = options.demo
  ? productSources
  : [
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
    const destination = path.join(bundle, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: true });
  }
  if (options.demo) {
    writeDemoPackageJson(path.join(bundle, "package.json"));
    fs.writeFileSync(path.join(bundle, "START_HERE.md"), demoGuide());
  } else {
    const startGuide =
      options.surface === "claude"
        ? path.join(root, "docs", "claude-friend-alpha.md")
        : path.join(root, "docs", "friend-alpha.md");
    writeRebrandedCopy(startGuide, path.join(bundle, "START_HERE.md"));
    writeRebrandedCopy(
      path.join(
        root,
        "docs",
        options.surface === "claude"
          ? "claude-alpha-results.md"
          : "friend-alpha-results.md"
      ),
      path.join(bundle, "RESULTS.md")
    );
  }
  fs.writeFileSync(
    path.join(bundle, options.demo ? "BUILD_INFO.txt" : "ALPHA_BUILD.txt"),
    [
      `Go Rot version: ${packageJson.version}`,
      `Package: ${packageDescription(options)}`,
      `Source commit: ${sourceCommit()}`,
      `Runtime source state: ${sourceState(productSources)}`,
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
    fail(result.stderr.trim() || "Could not create the package archive.");
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

function parseOptions(args) {
  if (args.length === 0) return { demo: false, surface: "all" };
  if (args.length === 1 && args[0] === "--demo") {
    return { demo: true, surface: "all" };
  }
  if (args.length === 2 && args[0] === "--surface" && args[1] === "claude") {
    return { demo: false, surface: "claude" };
  }
  fail("Usage: node scripts/package-alpha.mjs [--demo | --surface claude]");
}

function sourceCommit() {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  });
  return result.status === 0 ? result.stdout.trim() : "not available";
}

function sourceState(paths) {
  const result = spawnSync("git", ["status", "--porcelain", "--", ...paths], {
    cwd: root,
    encoding: "utf8"
  });
  if (result.status !== 0) return "not available";
  return result.stdout.trim() ? "uncommitted changes included" : "clean";
}

function packageDescription({ demo, surface }) {
  if (demo) return "macOS preview";
  return surface === "claude" ? "Claude friend alpha" : "general friend alpha";
}

function writeRebrandedCopy(source, destination) {
  const content = fs
    .readFileSync(source, "utf8")
    .replaceAll("FirstTok", "Go Rot")
    .replaceAll("`firsttok` folder", "`go-rot` folder")
    .replaceAll("**Ready**", "**Ready to rot.**")
    .replaceAll("**Test connection + feed**", "**Run feed check**");
  fs.writeFileSync(destination, content);
}

function writeDemoPackageJson(destination) {
  fs.writeFileSync(
    destination,
    `${JSON.stringify(
      {
        name: "go-rot",
        version: packageJson.version,
        private: true,
        type: "module",
        description: packageJson.description,
        scripts: {
          setup: "node scripts/install.mjs install --all",
          remove: "node scripts/install.mjs uninstall --all",
          doctor: "node scripts/doctor.mjs"
        },
        engines: packageJson.engines
      },
      null,
      2
    )}\n`
  );
}

function demoGuide() {
  return `# Go Rot

Prompt your agent. Go rot. Come back when it\u2019s cooked.

Go Rot opens your short-video feed while Codex or Claude works, parks the same
window when the agent needs you, and closes it when the work is ready. It only
receives local lifecycle signals; it does not read your prompts, answers,
browsing history, cookies, or feed content.

## What you need

- A Mac
- Google Chrome
- Node.js 20 or newer
- Codex or Claude Code

## Set up

1. Extract this zip and open Terminal in the extracted \`go-rot\` folder.
2. Run \`npm run setup\`.
3. Open \`chrome://extensions\` in Chrome.
4. Turn on **Developer mode**, choose **Load unpacked**, and select this
   package\u2019s \`extension\` folder.
5. Pin Go Rot, open it, choose a feed, and click **Run feed check**.
6. Fully quit and reopen your agent so it picks up the new hooks.
7. Codex only: enter \`/hooks\` once and trust the Go Rot hooks.

Start an agent task and go rot. The feed should open while it works, park when
permission or input is needed, return afterward, and close when the task ends.

If the panel says the companion is unavailable, click **Retry**. For a fuller
health check, run \`npm run doctor\` from this folder.

## Remove

Run \`npm run remove\`, then remove the unpacked Go Rot extension from
\`chrome://extensions\`.

## Preview-build note

This is the macOS preview build, so Chrome\u2019s one-time Developer mode and
Load unpacked steps are still required. A later Chrome Web Store build can
replace those two steps.
`;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
