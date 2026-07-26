import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function activateChromeFeed({
  platform = process.platform,
  run = execFileAsync
} = {}) {
  if (platform !== "darwin") return false;

  await run(
    "/usr/bin/osascript",
    ["-l", "JavaScript", "-e", targetedChromeActivationScript()],
    { timeout: 2_000 }
  );
  return true;
}

export function targetedChromeActivationScript() {
  return [
    'ObjC.import("AppKit");',
    'const apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier("com.google.Chrome");',
    'if (Number(apps.count) === 0) throw new Error("Google Chrome is not running.");',
    "const chrome = apps.objectAtIndex(0);",
    "const activated = chrome.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);",
    'if (!activated) throw new Error("Google Chrome could not be activated.");'
  ].join(" ");
}
