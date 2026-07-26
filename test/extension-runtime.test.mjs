import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SETTINGS } from "../extension/session-controller.mjs";

const events = {
  runtimeStartup: createEvent(),
  runtimeInstalled: createEvent(),
  runtimeMessage: createEvent(),
  windowRemoved: createEvent(),
  windowFocused: createEvent(),
  command: createEvent(),
  portMessage: createEvent(),
  portDisconnect: createEvent()
};
const postedToNative = [];
const createdWindows = [];
const removedWindows = [];
const updatedWindows = [];
const playbackChanges = [];
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
    onFocusChanged: events.windowFocused,
    async create(options) {
      const id = nextWindowId++;
      const created = { ...options, id, tabs: [{ id: id * 10 }] };
      createdWindows.push(created);
      return created;
    },
    async update(windowId, options) {
      updatedWindows.push({ windowId, ...options });
      if (options.focused) await events.windowFocused.emit(windowId);
      return { id: windowId, ...options };
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
  scripting: {
    async executeScript(options) {
      playbackChanges.push({
        tabId: options.target.tabId,
        paused: options.args[0]
      });
    }
  },
  action: {
    async setBadgeBackgroundColor() {},
    async setBadgeText({ text }) {
      badgeText.push(text);
    }
  }
};

await import("../extension/service-worker.mjs");

test("keeps one feed through permissions and concurrent turns", async () => {
  assert.deepEqual(postedToNative.shift(), { type: "companion.ping" });
  const blockedFeedTest = await events.runtimeMessage.request({
    type: "feed.test"
  });
  assert.equal(blockedFeedTest.ok, false);

  await events.portMessage.emit({ type: "companion.ready" });
  settings.pauseMedia = true;
  await lifecycle(work("work.started", "codex", "s1", "t1", "Terminal"));
  await waitFor(() => createdWindows.length === 1);

  await lifecycle(work("work.started", "claude-code", "s2", "t2", "iTerm"));
  assert.equal(createdWindows.length, 1);

  await lifecycle({
    ...work("attention.required", "codex", "s1", "t1", "Terminal"),
    reason: "permission"
  });
  assert.equal(removedWindows.length, 0);
  assert.ok(
    updatedWindows.some(
      (update) => update.windowId === 100 && update.state === "minimized"
    )
  );
  assert.deepEqual(playbackChanges.at(-1), { tabId: 1000, paused: true });
  assert.ok(
    postedToNative.some(
      (message) =>
        message.type === "source.focus" &&
        message.sessionId === "s1" &&
        message.final === false
    )
  );
  await lifecycle(work("work.resumed", "codex", "s1", "t1", "Terminal"));
  assert.equal(createdWindows.length, 1);
  assert.ok(
    updatedWindows.some(
      (update) =>
        update.windowId === 100 &&
        update.state === "normal" &&
        update.focused === true
    )
  );
  assert.deepEqual(playbackChanges.at(-1), { tabId: 1000, paused: false });

  await lifecycle(work("work.completed", "codex", "s1", "t1", "Terminal"));
  assert.equal(removedWindows.length, 0);
  assert.equal(badgeText.at(-1), "1");
  const whileSecondTaskRuns = await events.runtimeMessage.request({
    type: "status.get"
  });
  assert.deepEqual(whileSecondTaskRuns.activity, {
    working: 1,
    attention: 0,
    ready: 1
  });

  await lifecycle(
    work("work.completed", "claude-code", "s2", "t2", "iTerm")
  );
  assert.deepEqual(removedWindows, [100]);
  const afterAllTasksFinish = await events.runtimeMessage.request({
    type: "status.get"
  });
  assert.deepEqual(afterAllTasksFinish.activity, {
    working: 0,
    attention: 0,
    ready: 0
  });
  assert.equal(afterAllTasksFinish.backgroundReady, 0);
  assert.equal(badgeText.at(-1), "");
  assert.ok(
    postedToNative.some(
      (message) =>
        message.type === "source.focus" &&
        message.sessionId === "s2" &&
        message.final === true
    )
  );
});

test("terminal session event after an app switch notifies without stealing focus", async () => {
  await lifecycle(work("work.started", "codex", "s3", "t3", "Codex"));
  await waitFor(() => createdWindows.length === 2);
  await events.windowFocused.emit(999);
  const focusedUpdates = updatedWindows.filter(
    (update) => update.focused === true
  ).length;
  await lifecycle(work("work.resumed", "codex", "s3", "t3", "Codex"));
  assert.equal(
    updatedWindows.filter((update) => update.focused === true).length,
    focusedUpdates
  );
  const focusCount = postedToNative.filter(
    (message) => message.type === "source.focus"
  ).length;

  await lifecycle(work("session.ended", "codex", "s3", "t3", "Codex"));
  assert.deepEqual(removedWindows, [100, 101]);
  assert.equal(
    postedToNative.filter((message) => message.type === "source.focus").length,
    focusCount
  );
  assert.ok(
    postedToNative.some(
      (message) =>
        message.type === "source.notify" && message.sessionId === "s3"
    )
  );
});

test("a new answer turn reuses the exact parked feed", async () => {
  await lifecycle(
    work("work.started", "claude-code", "question-session", "q1", "Claude")
  );
  await waitFor(() => createdWindows.length === 3);
  await lifecycle({
    ...work(
      "attention.required",
      "claude-code",
      "question-session",
      "q1",
      "Claude"
    ),
    reason: "question"
  });
  await lifecycle(
    work("work.started", "claude-code", "question-session", "q2", "Claude")
  );

  assert.equal(createdWindows.length, 3);
  assert.ok(
    updatedWindows.some(
      (update) => update.windowId === 102 && update.state === "normal"
    )
  );

  await lifecycle(
    work("work.completed", "claude-code", "question-session", "q2", "Claude")
  );
  assert.equal(removedWindows.at(-1), 102);
});

test("manual return, window close, shortcut, and single-task Stop close the feed", async () => {
  await lifecycle(work("work.started", "codex", "manual", "one", "Codex"));
  await waitFor(() => createdWindows.length === 4);
  await events.runtimeMessage.request({ type: "session.return" });
  assert.equal(removedWindows.at(-1), 103);
  await lifecycle(work("work.completed", "codex", "manual", "one", "Codex"));

  await lifecycle(work("work.started", "codex", "stopped", "one", "Codex"));
  await waitFor(() => createdWindows.length === 5);
  await lifecycle(
    work("work.completed", "codex", "stopped", "one", "Codex")
  );
  assert.equal(removedWindows.at(-1), 104);

  await lifecycle(work("work.started", "codex", "window-close", "one", "Codex"));
  await waitFor(() => createdWindows.length === 6);
  await events.windowRemoved.emit(105);
  assert.ok(
    postedToNative.some(
      (message) =>
        message.type === "source.focus" &&
        message.sessionId === "window-close" &&
        message.reason === "manual"
    )
  );
  await lifecycle(
    work("work.completed", "codex", "window-close", "one", "Codex")
  );

  await lifecycle(work("work.started", "codex", "shortcut", "one", "Codex"));
  await waitFor(() => createdWindows.length === 7);
  await events.command.emit("return-to-agent");
  assert.equal(removedWindows.at(-1), 106);
});

test("explicit recovery closes the tracked feed and clears stuck activity", async () => {
  await events.runtimeMessage.request({ type: "activity.reset" });
  await lifecycle(work("work.started", "codex", "stale", "one", "Codex"));
  await waitFor(() => createdWindows.length === 8);
  await lifecycle({
    ...work("attention.required", "codex", "stale", "one", "Codex"),
    reason: "permission"
  });

  const result = await events.runtimeMessage.request({
    type: "activity.reset"
  });
  assert.equal(result.ok, true);
  assert.equal(result.cleared, 1);
  assert.equal(result.closedFeed, true);
  assert.equal(removedWindows.at(-1), 107);
  assert.ok(
    postedToNative.some((message) => message.type === "activity.reset")
  );

  const status = await events.runtimeMessage.request({ type: "status.get" });
  assert.deepEqual(status.activity, {
    working: 0,
    attention: 0,
    ready: 0
  });
  assert.equal(status.feedSession, null);
});

test("a native Claude decision event resumes the exact parked feed", async () => {
  await events.runtimeMessage.request({ type: "activity.reset" });
  await lifecycle(
    work("work.started", "claude-code", "native-decision", "unknown-turn", "Terminal")
  );
  await waitFor(() => createdWindows.length === 9);
  await lifecycle({
    ...work(
      "attention.required",
      "claude-code",
      "native-decision",
      "unknown-turn",
      "Terminal"
    ),
    reason: "permission"
  });

  const normalBefore = updatedWindows.filter(
    (update) => update.windowId === 108 && update.state === "normal"
  ).length;
  await lifecycle(
    work(
      "work.resumed",
      "claude-code",
      "native-decision",
      "unknown-turn",
      "Terminal"
    )
  );
  assert.equal(
    updatedWindows.filter(
      (update) => update.windowId === 108 && update.state === "normal"
    ).length,
    normalBefore + 1
  );

  await lifecycle(
    work("work.completed", "claude-code", "native-decision", "unknown-turn", "Terminal")
  );
  assert.equal(removedWindows.at(-1), 108);
});

test("a native Claude rejection closes the parked feed", async () => {
  await events.runtimeMessage.request({ type: "activity.reset" });
  await lifecycle(
    work("work.started", "claude-code", "native-reject", "unknown-turn", "Terminal")
  );
  await waitFor(() => createdWindows.length === 10);
  await lifecycle({
    ...work(
      "attention.required",
      "claude-code",
      "native-reject",
      "unknown-turn",
      "Terminal"
    ),
    reason: "permission"
  });

  await lifecycle(
    work(
      "work.completed",
      "claude-code",
      "native-reject",
      "unknown-turn",
      "Terminal"
    )
  );
  assert.equal(removedWindows.at(-1), 109);

  const status = await events.runtimeMessage.request({ type: "status.get" });
  assert.deepEqual(status.activity, {
    working: 0,
    attention: 0,
    ready: 0
  });
  assert.equal(status.feedSession, null);

  await lifecycle(
    work(
      "work.started",
      "claude-code",
      "native-reject",
      "unknown-turn",
      "Terminal"
    )
  );
  await waitFor(() => createdWindows.length === 11);
  assert.equal(createdWindows.at(-1).id, 110);
});

test("a manually minimized feed closes when completion has a different turn id", async () => {
  await events.runtimeMessage.request({ type: "activity.reset" });
  const windowsBefore = createdWindows.length;
  await lifecycle(
    work("work.started", "codex", "minimized-session", "submitted-turn", "Codex")
  );
  await waitFor(() => createdWindows.length === windowsBefore + 1);
  const minimizedWindowId = createdWindows.at(-1).id;

  await events.windowFocused.emit(-1);
  const minimized = await events.runtimeMessage.request({ type: "status.get" });
  assert.equal(minimized.feedSession.userLeft, true);

  await lifecycle(
    work(
      "work.completed",
      "codex",
      "minimized-session",
      "unknown-turn",
      "Codex"
    )
  );

  assert.equal(removedWindows.at(-1), minimizedWindowId);
  const completed = await events.runtimeMessage.request({ type: "status.get" });
  assert.deepEqual(completed.activity, {
    working: 0,
    attention: 0,
    ready: 0
  });
  assert.equal(completed.feedSession, null);
});

function work(type, agent, sessionId, turnId, sourceApp) {
  return {
    type,
    agent,
    surface: sourceApp === "Codex" || sourceApp === "Claude" ? "desktop" : "cli",
    sessionId,
    turnId,
    sourceApp
  };
}

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
