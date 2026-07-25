import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  clampSettings,
  sessionEligibility,
  sessionKey
} from "./session-controller.mjs";
import { SessionRegistry } from "./session-registry.mjs";

const NATIVE_HOST = "com.firsttok.companion";
const registry = new SessionRegistry();
let feedSession = null;
let nativePort = null;
let reconnectTimer = null;
let connectionState = "connecting";
let lastError = null;
let lifecycleQueue = Promise.resolve();

connectNative();

chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set(clampSettings(stored));
  connectNative();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const feed = feedSession;
  if (!feed || feed.windowId !== windowId || feed.closing) return;

  const source = feed.anchorEvent;
  clearFeedTimer(feed);
  feed.windowId = null;
  feed.state = "dismissed";
  feedSession = null;

  if (source) {
    focusSource(source, "manual", false);
  }
  broadcastStatus();
});

chrome.windows.onFocusChanged?.addListener((windowId) => {
  const feed = feedSession;
  if (!feed || feed.windowId === null || feed.closing) return;

  if (windowId === feed.windowId) {
    feed.ownsFocus = true;
    feed.userLeft = false;
    return;
  }

  if (feed.intentionalBlur) {
    feed.intentionalBlur = false;
    feed.ownsFocus = false;
    return;
  }

  if (feed.ownsFocus && feed.state === "active") {
    feed.ownsFocus = false;
    feed.userLeft = true;
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "return-to-agent") {
    closeFeed("shortcut");
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleUiMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

function connectNative() {
  if (nativePort) return;
  clearTimeout(reconnectTimer);
  connectionState = "connecting";

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    nativePort = port;
    port.onMessage.addListener(handleNativeMessage);
    port.onDisconnect.addListener(() => {
      lastError = chrome.runtime.lastError?.message ?? "Companion disconnected";
      connectionState = "disconnected";
      nativePort = null;
      broadcastStatus();
      scheduleReconnect();
    });
    port.postMessage({ type: "companion.ping" });
  } catch (error) {
    lastError = error.message;
    connectionState = "disconnected";
    nativePort = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectNative, 1500);
}

async function handleNativeMessage(message) {
  if (message.type === "companion.ready" || message.type === "companion.pong") {
    connectionState = "connected";
    lastError = null;
    broadcastStatus();
    return;
  }
  if (message.type === "companion.error") {
    lastError = message.message;
    broadcastStatus();
    return;
  }
  if (message.type === "lifecycle.event") {
    lifecycleQueue = lifecycleQueue
      .then(() => handleLifecycleEvent(message.event))
      .catch((error) => {
        lastError = error.message;
        broadcastStatus();
      });
    await lifecycleQueue;
  }
}

async function handleLifecycleEvent(event) {
  if (!event?.type) return;
  const key = sessionKey(event);

  if (event.type === "work.started") {
    const settings = await loadSettings();
    if (sessionEligibility(settings, event) !== "eligible") return;

    const started = registry.start(key, createTask(key, event));
    if (started.kind === "duplicate") return;

    if (!feedSession) {
      scheduleFeed(event, settings);
    } else {
      feedSession.anchorEvent = event;
      if (feedSession.state === "parked" && registry.counts().attention === 0) {
        await resumeFeed();
      }
    }
    await refreshStatus();
    return;
  }

  if (event.type === "work.resumed") {
    const resumed = registry.resume(key, event);
    if (resumed.kind === "resumed" && feedSession) {
      feedSession.anchorEvent = resumed.task.event;
      if (registry.counts().attention === 0) await resumeFeed();
    }
    await refreshStatus();
    return;
  }

  if (event.type === "attention.required") {
    const attention = registry.requireAttention(key, event);
    if (feedSession) {
      feedSession.anchorEvent = attention.task.event;
      await parkFeed(attention.task.event, event.reason);
    } else {
      focusSource(attention.task.event, event.reason, false);
    }
    await refreshStatus();
    return;
  }

  if (event.type === "work.completed") {
    registry.complete(key, event);
    if (registry.pendingCount() === 0) {
      if (feedSession) {
        await finishFeed("work.completed", event);
      } else {
        notifyReady(event);
      }
      registry.clearReady();
    } else {
      releaseTask(event);
      if (
        feedSession?.state === "parked" &&
        registry.counts().attention === 0
      ) {
        feedSession.anchorEvent = preferredPendingEvent() ?? event;
        await resumeFeed();
      }
    }
    await refreshStatus();
    return;
  }

  if (event.type === "session.ended") {
    registry.endSession(event.agent, event.sessionId);
    if (registry.pendingCount() === 0) {
      if (feedSession) {
        await finishFeed("session.ended", feedSession.anchorEvent ?? event);
      }
      registry.clearReady();
    } else if (feedSession) {
      feedSession.anchorEvent =
        preferredPendingEvent() ?? feedSession.anchorEvent;
    }
    await refreshStatus();
  }
}

function createTask(key, event) {
  return {
    key,
    event,
    state: "working",
    startedAt: event.timestamp ?? Date.now()
  };
}

function scheduleFeed(event, settings, delayMs = settings.delayMs) {
  const feed = {
    id: crypto.randomUUID(),
    state: "waiting",
    anchorEvent: event,
    settings,
    startedAt: Date.now(),
    timerId: null,
    windowId: null,
    ownsFocus: false,
    userLeft: false,
    intentionalBlur: false,
    closing: false,
    tabId: null
  };
  feedSession = feed;
  feed.timerId = setTimeout(
    () => openFeed(feed).catch((error) => failFeed(feed, error)),
    delayMs
  );
}

async function openFeed(feed) {
  if (
    feedSession !== feed ||
    feed.state !== "waiting" ||
    registry.pendingCount() === 0
  ) {
    return;
  }
  if (registry.counts().attention > 0) {
    feed.state = "parked";
    return;
  }

  const provider = PROVIDERS[feed.settings.provider];
  const display = await activeDisplayBounds();
  const width = Math.min(feed.settings.windowWidth, display.width);
  const height = Math.min(feed.settings.windowHeight, display.height);
  const left = display.left + Math.max(0, display.width - width - 24);
  const top = display.top + Math.max(0, Math.round((display.height - height) / 2));

  feed.state = "opening";
  const feedWindow = await chrome.windows.create({
    url: provider.url,
    type: "popup",
    focused: true,
    width,
    height,
    left,
    top
  });

  if (feedSession !== feed || feed.state !== "opening") {
    if (feedWindow.id !== undefined) await safeCloseWindow(feedWindow.id);
    return;
  }
  feed.windowId = feedWindow.id ?? null;
  feed.tabId =
    feedWindow.tabs?.[0]?.id ??
    (feed.windowId === null ? null : await firstTabId(feed.windowId));
  feed.state = "active";
  feed.ownsFocus = true;
  feed.userLeft = false;
  broadcastStatus();
}

async function parkFeed(event, reason) {
  const feed = feedSession;
  if (!feed) return;
  clearFeedTimer(feed);
  feed.state = "parked";
  feed.anchorEvent = event;

  if (feed.windowId !== null) {
    await setFeedPlayback(feed, true);
    feed.intentionalBlur = true;
    feed.ownsFocus = false;
    try {
      await chrome.windows.update(feed.windowId, { state: "minimized" });
    } catch {
      // Source focus still works if Chrome cannot minimize the popup.
    }
  }
  focusSource(event, reason, false);
}

async function resumeFeed() {
  const feed = feedSession;
  if (!feed || feed.closing || registry.counts().attention > 0) return;

  if (feed.windowId === null) {
    feed.state = "waiting";
    clearFeedTimer(feed);
    feed.timerId = setTimeout(
      () => openFeed(feed).catch((error) => failFeed(feed, error)),
      0
    );
    return;
  }

  try {
    await setFeedPlayback(feed, false);
    await chrome.windows.update(feed.windowId, {
      state: "normal",
      focused: true
    });
    feed.state = "active";
    feed.ownsFocus = true;
    feed.userLeft = false;
    feed.intentionalBlur = false;
  } catch (error) {
    failFeed(feed, error);
  }
}

async function finishFeed(reason, sourceEvent = feedSession?.anchorEvent) {
  const feed = feedSession;
  if (!feed) return false;

  clearFeedTimer(feed);
  feed.closing = true;
  const hadWindow = feed.windowId !== null;
  const shouldFocus =
    ["manual", "shortcut", "settings.changed"].includes(reason) ||
    (feed.state === "active" && feed.ownsFocus && !feed.userLeft);

  if (feed.windowId !== null) {
    await safeCloseWindow(feed.windowId);
    feed.windowId = null;
    feed.tabId = null;
  }
  feedSession = null;

  if (sourceEvent && shouldFocus && hadWindow) {
    focusSource(sourceEvent, reason, reason !== "manual" && reason !== "shortcut");
  } else if (
    sourceEvent &&
    ["work.completed", "session.ended"].includes(reason) &&
    hadWindow
  ) {
    notifyReady(sourceEvent);
  }
  return true;
}

async function closeFeed(reason) {
  return await finishFeed(reason, feedSession?.anchorEvent);
}

async function resetActivity() {
  const tasks = registry.clearAll();
  const feed = feedSession;
  const hadTrackedWindow = feed?.windowId !== null && feed?.windowId !== undefined;

  if (feed) {
    clearFeedTimer(feed);
    feed.closing = true;
    if (feed.windowId !== null) {
      await safeCloseWindow(feed.windowId);
    }
    feedSession = null;
  }

  nativePort?.postMessage({ type: "activity.reset" });
  await refreshStatus();
  return {
    cleared: tasks.length,
    closedFeed: hadTrackedWindow
  };
}

function clearFeedTimer(feed) {
  clearTimeout(feed.timerId);
  feed.timerId = null;
}

function focusSource(event, reason, final) {
  nativePort?.postMessage({
    type: "source.focus",
    agent: event.agent,
    sessionId: event.sessionId,
    turnId: event.turnId,
    sourceApp: event.sourceApp,
    reason,
    final
  });
}

function notifyReady(event) {
  nativePort?.postMessage({
    type: "source.notify",
    agent: event.agent,
    sessionId: event.sessionId,
    turnId: event.turnId,
    final: true
  });
}

function releaseTask(event) {
  nativePort?.postMessage({
    type: "task.release",
    agent: event.agent,
    sessionId: event.sessionId,
    turnId: event.turnId
  });
}

function preferredPendingEvent() {
  const tasks = registry.tasks();
  return (
    tasks.find((task) => task.state === "attention")?.event ??
    tasks.find((task) => task.state === "working")?.event ??
    null
  );
}

async function failFeed(feed, error) {
  if (feedSession !== feed) return;
  lastError = error.message;
  clearFeedTimer(feed);
  feedSession = null;
  broadcastStatus();
}

async function handleUiMessage(message) {
  if (message?.type === "status.get") {
    return { ok: true, ...(await statusSnapshot()) };
  }
  if (message?.type === "settings.update") {
    const current = await loadSettings();
    const settings = clampSettings({ ...current, ...message.settings });
    await chrome.storage.local.set(settings);
    if (
      feedSession &&
      (!settings.enabled || settings.pausedUntil > Date.now())
    ) {
      await finishFeed("settings.changed");
    }
    broadcastStatus();
    return { ok: true, settings };
  }
  if (message?.type === "background.clear") {
    registry.clearReady();
    await refreshStatus();
    return { ok: true };
  }
  if (message?.type === "activity.reset") {
    return { ok: true, ...(await resetActivity()) };
  }
  if (message?.type === "session.return") {
    return { ok: await closeFeed("manual") };
  }
  if (message?.type === "feed.test") {
    if (connectionState !== "connected") {
      throw new Error("The local companion is not connected.");
    }
    return { ok: true, windowId: await openTestFeed() };
  }
  if (message?.type === "companion.reconnect") {
    connectNative();
    return { ok: true };
  }
  throw new Error("Unknown extension message.");
}

async function openTestFeed() {
  const settings = await loadSettings();
  const provider = PROVIDERS[settings.provider];
  const feedWindow = await chrome.windows.create({
    url: provider.url,
    type: "popup",
    focused: true,
    width: settings.windowWidth,
    height: settings.windowHeight
  });
  if (feedWindow.id !== undefined) {
    setTimeout(() => safeCloseWindow(feedWindow.id), 3500);
  }
  return feedWindow.id ?? null;
}

async function statusSnapshot() {
  const settings = await loadSettings();
  const counts = registry.counts();
  const feed = feedSession;
  const anchor = feed?.anchorEvent;
  return {
    connectionState,
    lastError,
    settings,
    activity: counts,
    backgroundReady: counts.ready,
    feedSession: feed
      ? {
          scrollSessionId: feed.id,
          agent: anchor?.agent ?? null,
          surface: anchor?.surface ?? null,
          state: feed.state,
          startedAt: feed.startedAt,
          userLeft: feed.userLeft
        }
      : null,
    activeSession: feed
      ? {
          scrollSessionId: feed.id,
          agent: anchor?.agent ?? null,
          surface: anchor?.surface ?? null,
          state: feed.state,
          startedAt: feed.startedAt
        }
      : null
  };
}

async function loadSettings() {
  return clampSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
}

async function activeDisplayBounds() {
  const current = await chrome.windows.getLastFocused();
  return {
    left: current.left ?? 0,
    top: current.top ?? 0,
    width: current.width ?? 1440,
    height: current.height ?? 900
  };
}

async function safeCloseWindow(windowId) {
  try {
    await chrome.windows.remove(windowId);
  } catch {
    // The user may have already closed the window.
  }
}

async function firstTabId(windowId) {
  try {
    const tabs = await chrome.tabs.query({ windowId });
    return tabs[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function setFeedPlayback(feed, paused) {
  if (!feed.settings.pauseMedia || feed.tabId === null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: feed.tabId },
      func: togglePagePlayback,
      args: [paused]
    });
  } catch {
    // Optional site access may be absent or revoked. Parking still succeeds.
  }
}

function togglePagePlayback(paused) {
  const marker = "firsttokResumePlayback";
  for (const video of document.querySelectorAll("video")) {
    if (paused) {
      if (!video.paused) {
        video.dataset[marker] = "true";
        video.pause();
      }
      continue;
    }
    if (video.dataset[marker] === "true") {
      delete video.dataset[marker];
      video.play().catch(() => {});
    }
  }
}

function broadcastStatus() {
  statusSnapshot()
    .then((status) =>
      chrome.runtime.sendMessage({ type: "status.changed", status })
    )
    .catch(() => {});
}

async function refreshStatus() {
  await updateBadge();
  broadcastStatus();
}

async function updateBadge() {
  const counts = registry.counts();
  const urgent = counts.attention > 0;
  await chrome.action.setBadgeBackgroundColor({
    color: urgent ? "#A43D32" : "#E75235"
  });
  await chrome.action.setBadgeText({
    text: urgent ? "!" : counts.ready > 0 ? String(Math.min(counts.ready, 99)) : ""
  });
}
