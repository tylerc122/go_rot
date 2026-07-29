import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  clampSettings,
  nextFeedProvider,
  sessionEligibility,
  sessionKey
} from "./session-controller.mjs";
import { SessionRegistry } from "./session-registry.mjs";
import {
  captureWindowPlacement,
  resolveFeedBounds
} from "./window-placement.mjs";

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

chrome.windows.onBoundsChanged?.addListener(async (window) => {
  const feed = feedSession;
  if (!feed || feed.windowId !== window.id || feed.closing) return;
  const placement = captureWindowPlacement(window, await displayInfo());
  if (!placement) return;
  const settings = clampSettings({ ...feed.settings, ...placement });
  feed.settings = settings;
  await chrome.storage.local.set(placement);
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

  if (feed.ownsFocus && ["active", "finishing"].includes(feed.state)) {
    feed.ownsFocus = false;
    feed.userLeft = true;
    if (feed.state === "finishing") {
      finishFeed(
        feed.finishReason ?? "work.completed",
        feed.finishSourceEvent ?? feed.anchorEvent
      )
        .then(refreshStatus)
        .catch(() => {});
    }
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
  await recordObservedAgent(event);
  const key = sessionKey(event);

  if (event.type === "work.started") {
    const settings = await loadSettings();
    if (sessionEligibility(settings, event) !== "eligible") return;

    const started = registry.start(key, createTask(key, event));
    if (started.kind === "duplicate") return;

    if (!feedSession) {
      const provider = await selectFeedProvider(settings);
      scheduleFeed(event, settings, settings.delayMs, provider);
    } else {
      feedSession.anchorEvent = event;
      if (feedSession.state === "finishing") {
        await cancelFinishCurrentClip(feedSession);
      } else if (
        feedSession.state === "parked" &&
        registry.counts().attention === 0
      ) {
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
    const attention = registry.requireAttention(key, event, {
      recover: event.reason !== "question"
    });
    if (attention.kind === "missing") {
      await refreshStatus();
      return;
    }
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
        if (!startFinishCurrentClip(feedSession, "work.completed", event)) {
          await finishFeed("work.completed", event);
        }
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
        const sourceEvent = feedSession.anchorEvent ?? event;
        if (!startFinishCurrentClip(feedSession, "session.ended", sourceEvent)) {
          await finishFeed("session.ended", sourceEvent);
        }
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

function scheduleFeed(
  event,
  settings,
  delayMs = settings.delayMs,
  provider = settings.provider
) {
  const feed = {
    id: crypto.randomUUID(),
    state: "waiting",
    anchorEvent: event,
    settings,
    provider,
    startedAt: Date.now(),
    timerId: null,
    windowId: null,
    ownsFocus: false,
    userLeft: false,
    intentionalBlur: false,
    closing: false,
    tabId: null,
    finishGeneration: 0,
    finishCancel: null,
    finishReason: null,
    finishSourceEvent: null
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

  const provider = PROVIDERS[feed.provider];
  const bounds = await feedWindowBounds(feed.settings);

  feed.state = "opening";
  const feedWindow = await chrome.windows.create({
    url: provider.url,
    type: "popup",
    focused: true,
    width: bounds.width,
    height: bounds.height,
    left: bounds.left,
    top: bounds.top
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
  await foregroundFeed(feed);
  broadcastStatus();
}

async function parkFeed(event, reason) {
  const feed = feedSession;
  if (!feed) return;
  if (feed.state === "finishing") {
    await cancelFinishCurrentClip(feed);
  }
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
    await foregroundFeed(feed);
  } catch (error) {
    failFeed(feed, error);
  }
}

async function foregroundFeed(feed) {
  if (
    feedSession !== feed ||
    feed.windowId === null ||
    feed.closing ||
    !nativePort
  ) {
    return;
  }

  await chrome.windows.update(feed.windowId, { focused: true });
  nativePort.postMessage({
    type: "feed.activate",
    windowId: feed.windowId
  });
}

function startFinishCurrentClip(feed, reason, sourceEvent) {
  if (
    feedSession !== feed ||
    feed.closing ||
    !feed.settings.finishCurrentClip ||
    feed.state !== "active" ||
    !feed.ownsFocus ||
    feed.userLeft ||
    feed.windowId === null ||
    feed.tabId === null
  ) {
    return false;
  }

  clearFeedTimer(feed);
  feed.state = "finishing";
  feed.finishReason = reason;
  feed.finishSourceEvent = sourceEvent;
  const generation = ++feed.finishGeneration;
  broadcastStatus();
  completeAfterCurrentClip(feed, generation).catch((error) => {
    if (feedSession !== feed || feed.finishGeneration !== generation) return;
    lastError = error.message;
    finishFeed(reason, sourceEvent).then(refreshStatus).catch(() => {});
  });
  return true;
}

async function completeAfterCurrentClip(feed, generation) {
  const cancelled = new Promise((resolve) => {
    feed.finishCancel = resolve;
  });

  try {
    await Promise.race([
      chrome.scripting.executeScript({
        target: { tabId: feed.tabId },
        func: finishVisibleClip
      }),
      cancelled
    ]);
  } catch {
    // Missing or revoked site access falls back to the normal immediate return.
  } finally {
    if (feed.finishGeneration === generation) feed.finishCancel = null;
  }

  if (
    feedSession !== feed ||
    feed.finishGeneration !== generation ||
    feed.state !== "finishing" ||
    registry.pendingCount() > 0
  ) {
    return;
  }

  await finishFeed(feed.finishReason, feed.finishSourceEvent);
  await refreshStatus();
}

async function cancelFinishCurrentClip(feed) {
  if (feed.state !== "finishing") return;
  invalidateClipFinish(feed);
  feed.state = "active";
  feed.finishReason = null;
  feed.finishSourceEvent = null;
  broadcastStatus();

  if (feed.tabId === null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: feed.tabId },
      func: cancelFinishClipOverlay
    });
  } catch {
    // A navigation or revoked permission can remove the overlay for us.
  }
}

function invalidateClipFinish(feed) {
  feed.finishGeneration += 1;
  feed.finishCancel?.([{ result: { reason: "cancelled" } }]);
  feed.finishCancel = null;
}

async function finishFeed(reason, sourceEvent = feedSession?.anchorEvent) {
  const feed = feedSession;
  if (!feed) return false;

  clearFeedTimer(feed);
  feed.closing = true;
  invalidateClipFinish(feed);
  const hadWindow = feed.windowId !== null;
  const shouldFocus =
    ["manual", "shortcut", "settings.changed"].includes(reason) ||
    (["active", "finishing"].includes(feed.state) &&
      feed.ownsFocus &&
      !feed.userLeft);

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
    if (feedSession) feedSession.settings = settings;
    if (
      feedSession &&
      (!settings.enabled ||
        settings.pausedUntil > Date.now() ||
        (feedSession.state === "finishing" && !settings.finishCurrentClip))
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
  const selectedProvider = await selectFeedProvider(settings);
  const provider = PROVIDERS[selectedProvider];
  const bounds = await feedWindowBounds(settings);
  const feedWindow = await chrome.windows.create({
    url: provider.url,
    type: "popup",
    focused: true,
    width: bounds.width,
    height: bounds.height,
    left: bounds.left,
    top: bounds.top
  });
  await chrome.storage.local.set({ feedTested: true });
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
          provider: feed.provider,
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
          provider: feed.provider,
          startedAt: feed.startedAt
        }
      : null
  };
}

async function loadSettings() {
  return clampSettings(await chrome.storage.local.get(DEFAULT_SETTINGS));
}

async function recordObservedAgent(event) {
  if (
    event.type !== "work.started" ||
    !["codex", "claude-code"].includes(event.agent)
  ) {
    return;
  }
  const settings = await loadSettings();
  if (settings.observedAgents[event.agent] > 0) return;
  await chrome.storage.local.set({
    observedAgents: {
      ...settings.observedAgents,
      [event.agent]: event.timestamp ?? Date.now()
    }
  });
}

async function selectFeedProvider(settings) {
  const provider = nextFeedProvider(settings);
  if (settings.shuffleFeeds && settings.lastShuffledProvider !== provider) {
    await chrome.storage.local.set({ lastShuffledProvider: provider });
  }
  return provider;
}

async function feedWindowBounds(settings) {
  const anchor = await chrome.windows.getLastFocused();
  return resolveFeedBounds(settings, await displayInfo(anchor), anchor);
}

async function displayInfo(anchor = null) {
  try {
    const displays = await chrome.system?.display?.getInfo?.();
    if (Array.isArray(displays) && displays.length > 0) return displays;
  } catch {
    // Fall back to the last focused Chrome window below.
  }
  const current = anchor ?? (await chrome.windows.getLastFocused());
  const bounds = {
    left: current.left ?? 0,
    top: current.top ?? 0,
    width: current.width ?? 1440,
    height: current.height ?? 900
  };
  return [{ id: "fallback", isPrimary: true, bounds, workArea: bounds }];
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

function cancelFinishClipOverlay() {
  document.dispatchEvent(new CustomEvent("firsttok:cancel-finish-clip"));
  document.getElementById("firsttok-finish-clip")?.remove();
}

function finishVisibleClip() {
  const overlayId = "firsttok-finish-clip";
  const cancelEvent = "firsttok:cancel-finish-clip";
  document.getElementById(overlayId)?.remove();

  let video = findVisiblePlayingVideo();

  if (!video || video.duration - video.currentTime <= 0.25) {
    return { reason: "no-playing-video" };
  }

  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.id = overlayId;
    host.style.setProperty("position", "fixed", "important");
    host.style.setProperty("left", "50%", "important");
    host.style.setProperty("bottom", "24px", "important");
    host.style.setProperty("transform", "translateX(-50%)", "important");
    host.style.setProperty("z-index", "2147483647", "important");
    host.style.setProperty("pointer-events", "auto", "important");

    const shadow = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; }
      .notice {
        box-sizing: border-box;
        display: flex;
        min-width: 280px;
        max-width: min(420px, calc(100vw - 32px));
        align-items: center;
        gap: 12px;
        padding: 10px 10px 10px 14px;
        border: 1px solid oklch(72% 0.03 302);
        border-radius: 10px;
        background: oklch(95% 0.024 302);
        box-shadow: 0 8px 28px oklch(20% 0.025 292 / 0.22);
        color: oklch(23% 0.018 292);
        font: 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .copy {
        display: flex;
        min-width: 0;
        flex: 1;
        flex-direction: column;
      }
      strong { font-size: 13px; font-weight: 750; letter-spacing: -0.01em; }
      span { color: oklch(48% 0.018 292); font-size: 12px; }
      button {
        min-height: 40px;
        flex: 0 0 auto;
        padding: 0 13px;
        border: 1px solid oklch(23% 0.018 292);
        border-radius: 8px;
        background: oklch(23% 0.018 292);
        color: oklch(97.5% 0.01 302);
        cursor: pointer;
        font: 650 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      button:hover { background: oklch(30% 0.02 292); }
      button:focus-visible {
        outline: 3px solid oklch(55% 0.15 302);
        outline-offset: 2px;
      }
    `;
    const notice = document.createElement("div");
    notice.className = "notice";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");

    const copy = document.createElement("div");
    copy.className = "copy";
    const title = document.createElement("strong");
    title.textContent = "Agent cooked";
    const detail = document.createElement("span");
    detail.textContent = "Finish this clip, then back to it";
    copy.append(title, detail);

    const returnNow = document.createElement("button");
    returnNow.type = "button";
    returnNow.textContent = "Back now";
    notice.append(copy, returnNow);
    shadow.append(style, notice);
    document.documentElement.append(host);

    const initialSourceUrl = video.currentSrc;
    let previousTime = video.currentTime;
    let settled = false;
    let identityTimerId;

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearInterval(identityTimerId);
      stopWatchingVideo(video);
      document.removeEventListener(cancelEvent, onCancel);
      host.remove();
      resolve({ reason });
    };
    const onEnded = () => finish("ended");
    const onTimeUpdate = () => {
      const currentTime = video.currentTime;
      if (currentTime + 0.25 >= video.duration) {
        finish("ended");
        return;
      }
      if (
        previousTime >= video.duration - 0.75 &&
        currentTime < Math.min(1, video.duration * 0.1)
      ) {
        finish("looped");
        return;
      }
      previousTime = currentTime;
    };
    const onClipIdentityCheck = () => {
      const currentSourceUrl = video.currentSrc;
      if (
        initialSourceUrl &&
        currentSourceUrl &&
        currentSourceUrl !== initialSourceUrl
      ) {
        finish("media-source-changed");
        return;
      }

      const visiblePlayingVideo = findVisiblePlayingVideo();
      if (visiblePlayingVideo && visiblePlayingVideo !== video) {
        const visibleSourceUrl = visiblePlayingVideo.currentSrc;
        if (
          initialSourceUrl &&
          visibleSourceUrl &&
          visibleSourceUrl !== initialSourceUrl
        ) {
          finish("visible-video-changed");
          return;
        }

        stopWatchingVideo(video);
        video = visiblePlayingVideo;
        previousTime = video.currentTime;
        watchVideo(video);
      }
    };
    const watchVideo = (candidate) => {
      candidate.addEventListener("ended", onEnded, { once: true });
      candidate.addEventListener("timeupdate", onTimeUpdate);
      candidate.addEventListener("loadstart", onClipIdentityCheck);
    };
    const stopWatchingVideo = (candidate) => {
      candidate.removeEventListener("ended", onEnded);
      candidate.removeEventListener("timeupdate", onTimeUpdate);
      candidate.removeEventListener("loadstart", onClipIdentityCheck);
    };
    const onCancel = () => finish("cancelled");

    returnNow.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      finish("return-now");
    });
    watchVideo(video);
    document.addEventListener(cancelEvent, onCancel, { once: true });
    identityTimerId = setInterval(onClipIdentityCheck, 100);
  });

  function findVisiblePlayingVideo() {
    return [...document.querySelectorAll("video")]
      .map((candidate) => ({
        candidate,
        score: visibleVideoArea(candidate)
      }))
      .filter(
        ({ candidate, score }) =>
          score > 0 &&
          !candidate.paused &&
          !candidate.ended &&
          Number.isFinite(candidate.duration) &&
          candidate.duration > 0 &&
          Number.isFinite(candidate.currentTime) &&
          candidate.playbackRate > 0
      )
      .sort((left, right) => right.score - left.score)[0]?.candidate;
  }

  function visibleVideoArea(candidate) {
    const style = getComputedStyle(candidate);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      Number(style.opacity) === 0
    ) {
      return 0;
    }
    const rect = candidate.getBoundingClientRect();
    const width = Math.max(
      0,
      Math.min(rect.right, innerWidth) - Math.max(rect.left, 0)
    );
    const height = Math.max(
      0,
      Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0)
    );
    return width * height;
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
