import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  frontmostApplicationScript,
  isSourceApplicationFrontmost,
  matchesSourceApplication,
  sendGoRotNotification
} from "../companion/macos-notification.mjs";

test("Codex is recognized as the originating frontmost app", async () => {
  const frontmost = await isSourceApplicationFrontmost("Codex", {
    platform: "darwin",
    async run(file, args, options) {
      assert.equal(file, "/usr/bin/osascript");
      assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
      assert.equal(options.timeout, 2_000);
      return {
        stdout: JSON.stringify({
          name: "Codex",
          bundleIdentifier: "com.openai.codex"
        })
      };
    }
  });

  assert.equal(frontmost, true);
});

test("a different foreground app does not suppress completion", async () => {
  const frontmost = await isSourceApplicationFrontmost("Codex", {
    platform: "darwin",
    async run() {
      return {
        stdout: JSON.stringify({
          name: "Google Chrome",
          bundleIdentifier: "com.google.Chrome"
        })
      };
    }
  });

  assert.equal(frontmost, false);
});

test("frontmost checks fail open so an alert is not accidentally lost", async () => {
  const frontmost = await isSourceApplicationFrontmost("Codex", {
    platform: "darwin",
    async run() {
      throw new Error("workspace unavailable");
    }
  });

  assert.equal(frontmost, false);
});

test("source application aliases cover supported terminals and Cursor", () => {
  assert.equal(
    matchesSourceApplication("iTerm", {
      name: "iTerm2",
      bundleIdentifier: "com.googlecode.iterm2"
    }),
    true
  );
  assert.equal(
    matchesSourceApplication("Visual Studio Code", {
      name: "Cursor",
      bundleIdentifier: "com.todesktop.230313mzl4w4u92"
    }),
    true
  );
});

test("the foreground script returns application identity without source input", () => {
  const script = frontmostApplicationScript();
  assert.match(script, /frontmostApplication/);
  assert.match(script, /bundleIdentifier/);
  assert.doesNotMatch(script, /Codex/);
});

test("production notifications are delivered by the Go Rot app executable", async () => {
  const calls = [];
  const appBundle = "/Applications/Go Rot.app";
  const delivered = await sendGoRotNotification("Codex cooked.", {
    platform: "darwin",
    appBundle,
    async access(file) {
      assert.equal(
        file,
        path.join(appBundle, "Contents", "MacOS", "go-rot")
      );
    },
    async run(file, args, options) {
      calls.push({ file, args, options });
    }
  });

  assert.equal(delivered, true);
  assert.deepEqual(calls, [
    {
      file: "/Applications/Go Rot.app/Contents/MacOS/go-rot",
      args: ["--notify", "Codex cooked."],
      options: { timeout: 2_000 }
    }
  ]);
});

test("development notifications safely fall back to osascript", async () => {
  const calls = [];
  const delivered = await sendGoRotNotification('Codex "cooked".', {
    platform: "darwin",
    appBundle: null,
    async run(file, args, options) {
      calls.push({ file, args, options });
    }
  });

  assert.equal(delivered, true);
  assert.equal(calls[0].file, "/usr/bin/osascript");
  assert.equal(
    calls[0].args[1],
    'display notification "Codex \\"cooked\\"." with title "Go Rot"'
  );
});
