import fs from "node:fs/promises";
import path from "node:path";
import { constants as fsConstants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const APPLICATION_IDENTITIES = {
  Codex: {
    names: ["Codex"],
    bundleIdentifiers: ["com.openai.codex"]
  },
  Claude: {
    names: ["Claude"],
    bundleIdentifiers: [
      "com.anthropic.Claude",
      "com.anthropic.claudefordesktop"
    ]
  },
  Terminal: {
    names: ["Terminal"],
    bundleIdentifiers: ["com.apple.Terminal"]
  },
  iTerm: {
    names: ["iTerm", "iTerm2"],
    bundleIdentifiers: ["com.googlecode.iterm2"]
  },
  Warp: {
    names: ["Warp"],
    bundleIdentifiers: ["dev.warp.Warp", "dev.warp.Warp-Stable"]
  },
  WezTerm: {
    names: ["WezTerm"],
    bundleIdentifiers: ["com.github.wez.wezterm"]
  },
  Ghostty: {
    names: ["Ghostty"],
    bundleIdentifiers: ["com.mitchellh.ghostty"]
  },
  "Visual Studio Code": {
    names: ["Visual Studio Code", "Code", "Cursor"],
    bundleIdentifiers: [
      "com.microsoft.VSCode",
      "com.microsoft.VSCodeInsiders",
      "com.todesktop.230313mzl4w4u92"
    ]
  }
};

export async function isSourceApplicationFrontmost(
  sourceApp,
  {
    platform = process.platform,
    run = execFileAsync
  } = {}
) {
  if (platform !== "darwin" || !sourceApp) return false;

  try {
    const result = await run(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", frontmostApplicationScript()],
      { timeout: 2_000 }
    );
    const output = typeof result === "string" ? result : result?.stdout;
    const frontmost = JSON.parse(String(output ?? "").trim());
    return matchesSourceApplication(sourceApp, frontmost);
  } catch {
    // If macOS cannot report the foreground app, preserve notification delivery.
    return false;
  }
}

export async function sendGoRotNotification(
  body,
  {
    platform = process.platform,
    appBundle = process.env.GO_ROT_APP_BUNDLE,
    access = fs.access,
    run = execFileAsync
  } = {}
) {
  if (platform !== "darwin") return false;

  if (appBundle) {
    const applicationExecutable = path.join(
      appBundle,
      "Contents",
      "MacOS",
      "go-rot"
    );
    try {
      await access(applicationExecutable, fsConstants.X_OK);
      await run(applicationExecutable, ["--notify", String(body)], {
        timeout: 2_000
      });
      return true;
    } catch {
      // Development installs and damaged app bundles can still use the fallback.
    }
  }

  try {
    await run(
      "/usr/bin/osascript",
      [
        "-e",
        `display notification "${escapeAppleScript(body)}" with title "Go Rot"`
      ],
      { timeout: 2_000 }
    );
    return true;
  } catch {
    return false;
  }
}

export function frontmostApplicationScript() {
  return [
    'ObjC.import("AppKit");',
    "const application = $.NSWorkspace.sharedWorkspace.frontmostApplication;",
    "const result = application ? {",
    '  name: ObjC.unwrap(application.localizedName) || "",',
    '  bundleIdentifier: ObjC.unwrap(application.bundleIdentifier) || ""',
    '} : { name: "", bundleIdentifier: "" };',
    "JSON.stringify(result);"
  ].join(" ");
}

export function matchesSourceApplication(sourceApp, frontmost) {
  const identity = APPLICATION_IDENTITIES[sourceApp] ?? {
    names: [sourceApp],
    bundleIdentifiers: []
  };
  const name = normalize(frontmost?.name);
  const bundleIdentifier = String(frontmost?.bundleIdentifier ?? "").toLowerCase();
  return (
    identity.names.some((candidate) => normalize(candidate) === name) ||
    identity.bundleIdentifiers.some(
      (candidate) => candidate.toLowerCase() === bundleIdentifier
    )
  );
}

function normalize(value) {
  return String(value ?? "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "");
}

function escapeAppleScript(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
