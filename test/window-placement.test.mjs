import test from "node:test";
import assert from "node:assert/strict";
import {
  captureWindowPlacement,
  resolveFeedBounds
} from "../extension/window-placement.mjs";

const displays = [
  {
    id: "main",
    isPrimary: true,
    isEnabled: true,
    bounds: { left: 0, top: 0, width: 1440, height: 900 },
    workArea: { left: 0, top: 24, width: 1440, height: 876 }
  },
  {
    id: "side",
    isPrimary: false,
    isEnabled: true,
    bounds: { left: 1440, top: 0, width: 1920, height: 1080 },
    workArea: { left: 1440, top: 24, width: 1920, height: 1056 }
  }
];

test("restores remembered feed bounds on the same display", () => {
  assert.deepEqual(
    resolveFeedBounds(
      {
        windowDisplayId: "side",
        windowLeft: 1700,
        windowTop: 100,
        windowWidth: 500,
        windowHeight: 800
      },
      displays,
      { left: 100, top: 100, width: 900, height: 700 }
    ),
    {
      displayId: "side",
      left: 1700,
      top: 100,
      width: 500,
      height: 800
    }
  );
});

test("falls back safely when the remembered display disappears", () => {
  const result = resolveFeedBounds(
    {
      windowDisplayId: "missing",
      windowLeft: 2000,
      windowTop: 50,
      windowWidth: 480,
      windowHeight: 820
    },
    displays.slice(0, 1),
    { left: 100, top: 100, width: 900, height: 700 }
  );
  assert.equal(result.displayId, "main");
  assert.equal(result.left, 936);
  assert.equal(result.top, 52);
});

test("captures committed window bounds and their display", () => {
  assert.deepEqual(
    captureWindowPlacement(
      {
        state: "normal",
        left: 1600,
        top: 80,
        width: 520,
        height: 840
      },
      displays
    ),
    {
      windowLeft: 1600,
      windowTop: 80,
      windowWidth: 520,
      windowHeight: 840,
      windowDisplayId: "side"
    }
  );
  assert.equal(
    captureWindowPlacement(
      { state: "minimized", left: 0, top: 0, width: 500, height: 800 },
      displays
    ),
    null
  );
});
