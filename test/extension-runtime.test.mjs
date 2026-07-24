import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../extension/session-controller.mjs";

const events = {
  runtimeStartup: createEvent(),
  runtimeInstalled: createEvent(),
  runtimeMessage: createEvent(),
  windowRemoved: createEvent(),
  command: createEvent(),
  portMessage: createEvent(),
  portDisconnect: createEvent()
};
const postedToNative = [];
const createdWindows = [];
const removedWindows = [];
const badgeText = [];
const settings = {
  ...DEFAULT_SETTINGS,
  agents: { ...DEFAULT_SETTINGS.agents },
  delayMs: 0
};
let nextWindowId = 100;

const nativePort = {
  onMessage: events.portMessage,
  onDisconnect: events.portDisconnect,
  postMessage(message) {
    postedToNative.push(message);
  }
};

globalThis.chrome = {
  runtime: {
    lastError: null,
    onStartup: events.runtimeStartup,
    onInstalled: events.runtimeInstalled,
    onMessage: events.runtimeMessage,
    connectNative() {
      return nativePort;
    },
    async sendMessage() {}
  },
  storage: {
    local: {
      async get(defaults) {
        return { ...defaults, ...settings, agents: { ...settings.agents } };
      },
      async set(patch) {
        Object.assign(settings, patch);
      }
    }
  },
  windows: {
    onRemoved: events.windowRemoved,
    async create(options) {
      const created = { ...options, id: nextWindowId++ };
      createdWindows.push(created);
      return created;
    },
    async remove(windowId) {
      removedWindows.push(windowId);
      await events.windowRemoved.emit(windowId);
    },
    async getLastFocused() {
      return { left: 10, top: 20, width: 1400, height: 900 };
    }
  },
  commands: {
    onCommand: events.command
  },
  action: {
    async setBadgeBackgroundColor() {},
    async setBadgeText({ text }) {
      badgeText.push(text);
    }
  }
};

await import("../extension/service-worker.mjs");

test("extension runtime opens, closes, deduplicates, and isolates concurrent turns", async () => {
  assert.deepEqual(postedToNative.shift(), { type: "companion.ping" });
  const blockedFeedTest = await events.runtimeMessage.request({
    type: "feed.test"
  });
  assert.equal(blockedFeedTest.ok, false);
  assert.match(blockedFeedTest.error, /companion is not connected/i);
  assert.equal(createdWindows.length, 0);

  await events.portMessage.emit({ type: "companion.ready" });

  await lifecycle({
    type: "work.started",
    agent: "codex",
    surface: "cli",
    sessionId: "s1",
    turnId: "t1",
    sourceApp: "Terminal"
  });
  await waitFor(() => createdWindows.length === 1);
  assert.equal(createdWindows[0].url, "https://www.youtube.com/shorts");
  assert.equal(createdWindows[0].type, "popup");

  await lifecycle({
    type: "work.started",
    agent: "codex",
    surface: "cli",
    sessionId: "s1",
    turnId: "t1",
    sourceApp: "Terminal"
  });
  assert.equal(createdWindows.length, 1);

  await lifecycle({
    type: "work.started",
    agent: "claude-code",
    surface: "cli",
    sessionId: "s2",
    turnId: "t2",
    sourceApp: "iTerm"
  });
  await lifecycle({
    type: "work.completed",
    agent: "claude-code",
    surface: "cli",
    sessionId: "s2",
    turnId: "t2",
    sourceApp: "iTerm"
  });
  assert.equal(removedWindows.length, 0);
  assert.equal(badgeText.at(-1), "1");

  await lifecycle({
    type: "attention.required",
    reason: "permission",
    agent: "codex",
    surface: "cli",
    sessionId: "s1",
    turnId: "t1",
    sourceApp: "Terminal"
  });
  assert.deepEqual(removedWindows, [100]);
  const closed = postedToNative.find((message) => message.type === "feed.closed");
  assert.equal(closed.agent, "codex");
  assert.equal(closed.reason, "attention.required");

  await lifecycle({
    type: "work.started",
    agent: "claude-code",
    surface: "desktop",
    sessionId: "s3",
    turnId: "t3",
    sourceApp: "Claude"
  });
  await waitFor(() => createdWindows.length === 2);
  const messagesBeforeEnd = postedToNative.length;
  await lifecycle({
    type: "session.ended",
    agent: "claude-code",
    surface: "desktop",
    sessionId: "s3",
    turnId: "unknown-turn",
    sourceApp: "Claude"
  });
  assert.deepEqual(removedWindows, [100, 101]);
  assert.equal(postedToNative.length, messagesBeforeEnd);

  await lifecycle({
    type: "work.started",
    agent: "codex",
    surface: "desktop",
    sessionId: "s4",
    turnId: "t4",
    sourceApp: "Codex"
  });
  await waitFor(() => createdWindows.length === 3);
  const disabled = await events.runtimeMessage.request({
    type: "settings.update",
    settings: { enabled: false }
  });
  assert.equal(disabled.ok, true);
  assert.equal(disabled.settings.enabled, false);
  assert.deepEqual(removedWindows, [100, 101, 102]);

  await lifecycle({
    type: "work.started",
    agent: "codex",
    surface: "desktop",
    sessionId: "s5",
    turnId: "t5",
    sourceApp: "Codex"
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(createdWindows.length, 3);

  await events.runtimeMessage.request({
    type: "settings.update",
    settings: { enabled: true }
  });
  await lifecycle({
    type: "work.started",
    agent: "codex",
    surface: "cli",
    sessionId: "s6",
    turnId: "t6",
    sourceApp: "Terminal"
  });
  await waitFor(() => createdWindows.length === 4);
  await events.windowRemoved.emit(103);
  assert.ok(
    postedToNative.some(
      (message) => message.type === "feed.closed" && message.reason === "manual"
    )
  );

  await lifecycle({
    type: "work.started",
    agent: "claude-code",
    surface: "cli",
    sessionId: "s7",
    turnId: "t7",
    sourceApp: "iTerm"
  });
  await waitFor(() => createdWindows.length === 5);
  await events.command.emit("return-to-agent");
  await waitFor(() =>
    postedToNative.some(
      (message) => message.type === "feed.closed" && message.reason === "shortcut"
    )
  );
  assert.equal(removedWindows.at(-1), 104);
  assert.ok(
    postedToNative.some(
      (message) => message.type === "feed.closed" && message.reason === "shortcut"
    )
  );
});

async function lifecycle(event) {
  await events.portMessage.emit({ type: "lifecycle.event", event });
}

function createEvent() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    async emit(...args) {
      await Promise.all(listeners.map((listener) => listener(...args)));
    },
    request(message) {
      return new Promise((resolve, reject) => {
        if (listeners.length !== 1) {
          reject(new Error(`Expected one message listener, found ${listeners.length}`));
          return;
        }
        try {
          const result = listeners[0](message, {}, resolve);
          if (result !== true && result !== undefined) resolve(result);
        } catch (error) {
          reject(error);
        }
      });
    }
  };
}

async function waitFor(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for extension state.");
}
