import test from "node:test";
import assert from "node:assert/strict";
import {
  activateChromeFeed,
  targetedChromeActivationScript
} from "../companion/macos-activation.mjs";

test("targeted Chrome activation raises only its main and key windows", async () => {
  const calls = [];
  const activated = await activateChromeFeed({
    platform: "darwin",
    async run(file, args, options) {
      calls.push({ file, args, options });
    }
  });

  assert.equal(activated, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, "/usr/bin/osascript");
  assert.deepEqual(calls[0].args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.equal(calls[0].options.timeout, 2_000);
  assert.match(calls[0].args[3], /com\.google\.Chrome/);
  assert.match(calls[0].args[3], /NSApplicationActivateIgnoringOtherApps/);
  assert.doesNotMatch(calls[0].args[3], /NSApplicationActivateAllWindows/);
});

test("targeted Chrome activation is inert away from macOS", async () => {
  let called = false;
  const activated = await activateChromeFeed({
    platform: "linux",
    async run() {
      called = true;
    }
  });

  assert.equal(activated, false);
  assert.equal(called, false);
});

test("the activation script never requests all Chrome windows", () => {
  const script = targetedChromeActivationScript();
  assert.match(script, /activateWithOptions/);
  assert.doesNotMatch(script, /ActivateAllWindows/);
});
