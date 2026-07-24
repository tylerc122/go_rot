import {
  DEFAULT_SETTINGS,
  PROVIDERS,
  clampSettings,
  isTerminalEvent,
  sessionEligibility,
  sessionKey
} from "./session-controller.mjs";
import { SessionRegistry } from "./session-registry.mjs";

const NATIVE_HOST = "com.firsttok.companion";
const registry = new SessionRegistry();
let nativePort = null;
let reconnectTimer = null;
let connectionState = "connecting";
let lastError = null;

connectNative();

chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  await chrome.storage.local.set(clampSettings(stored));
  connectNative();
});

chrome.windows.onRemoved.addListener(async (windowId) => {
  const session = registry.active();
  if (!session || session.windowId !== windowId || session.closing) return;

  session.windowId = null;
  session.state = "dismissed";
  await returnToSource(session, "manual");
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "return-to-agent") {
    closeActiveSession("shortcut");
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
    await handleLifecycleEvent(message.event);
  }
}

async function handleLifecycleEvent(event) {
  if (!event?.type) return;
  const key = sessionKey(event);

  if (event.type === "work.started") {
    const settings = await loadSettings();
    if (sessionEligibility(settings, event) !== "eligible") return;

    const session = {
      id: crypto.randomUUID(),
      key,
      event,
      state: "waiting",
      startedAt: Date.now(),
      endedAt: null,
      endReason: null,
      manuallyDismissed: false,
      timerId: null,
      windowId: null,
      closing: false,
      settings
    };
    const start = registry.start(key, session);

    if (start.kind === "duplicate") return;
    if (start.kind === "background") {
      broadcastStatus();
      return;
    }
    session.timerId = setTimeout(
      () => openFeed(session).catch((error) => failSession(session, error)),
      settings.delayMs
    );
    broadcastStatus();
    return;
  }

  if (event.type === "session.ended") {
    const active = registry.endSession(event.agent, event.sessionId);
    if (active) {
      await finishSession(active, event.type);
    } else {
      broadcastStatus();
    }
    return;
  }

  if (isTerminalEvent(event)) {
    const terminal = registry.terminal(key);
    if (terminal.kind === "missing") return;
    if (terminal.kind === "background") {
      await updateBadge();
      broadcastStatus();
      return;
    }
    await finishSession(terminal.session, event.type);
  }
}

async function openFeed(session) {
  if (session.state !== "waiting" || !registry.isActive(session.key)) return;
  const provider = PROVIDERS[session.settings.provider];
  const display = await activeDisplayBounds();
  const width = Math.min(session.settings.windowWidth, display.width);
  const height = Math.min(session.settings.windowHeight, display.height);
  const left = display.left + Math.max(0, display.width - width - 24);
  const top = display.top + Math.max(0, Math.round((display.height - height) / 2));

  session.state = "opening";
  const feedWindow = await chrome.windows.create({
    url: provider.url,
    type: "popup",
    focused: true,
    width,
    height,
    left,
    top
  });

  if (session.state !== "opening") {
    if (feedWindow.id) await safeCloseWindow(feedWindow.id);
    return;
  }
  session.windowId = feedWindow.id ?? null;
  session.state = "active";
  broadcastStatus();
}

async function finishSession(session, reason) {
  clearTimeout(session.timerId);
  session.timerId = null;
  session.closing = true;
  session.state = "returning";
  session.endedAt = Date.now();
  session.endReason = reason;

  if (session.windowId !== null) {
    await safeCloseWindow(session.windowId);
    session.windowId = null;
  }
  if (reason === "session.ended") {
    registry.complete(session.key);
    broadcastStatus();
    return;
  }
  await returnToSource(session, reason);
}

async function returnToSource(session, reason) {
  session.endedAt ??= Date.now();
  session.endReason ??= reason;
  session.manuallyDismissed ||= ["manual", "shortcut"].includes(reason);
  nativePort?.postMessage({
    type: "feed.closed",
    agent: session.event.agent,
    sessionId: session.event.sessionId,
    turnId: session.event.turnId,
    reason,
    final: true
  });
  registry.complete(session.key);
  broadcastStatus();
}

async function failSession(session, error) {
  lastError = error.message;
  clearTimeout(session.timerId);
  registry.complete(session.key);
  broadcastStatus();
}

async function closeActiveSession(reason) {
  const session = registry.active();
  if (!session) return false;
  await finishSession(session, reason);
  return true;
}

async function handleUiMessage(message) {
  if (message?.type === "status.get") {
    return { ok: true, ...(await statusSnapshot()) };
  }
  if (message?.type === "settings.update") {
    const current = await loadSettings();
    const settings = clampSettings({ ...current, ...message.settings });
    await chrome.storage.local.set(settings);
    const active = registry.active();
    if (
      active &&
      (!settings.enabled ||
        settings.pausedUntil > Date.now() ||
        settings.agents[active.event.agent] === false)
    ) {
      await finishSession(active, "settings.changed");
    }
    broadcastStatus();
    return { ok: true, settings };
  }
  if (message?.type === "background.clear") {
    registry.clearReady();
    await updateBadge();
    broadcastStatus();
    return { ok: true };
  }
  if (message?.type === "session.return") {
    return { ok: await closeActiveSession("manual") };
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
  const active = registry.active();
  return {
    connectionState,
    lastError,
    settings,
    backgroundReady: registry.readyCount(),
    activeSession: active
      ? {
          scrollSessionId: active.id,
          agent: active.event.agent,
          surface: active.event.surface,
          state: active.state,
          startedAt: active.startedAt
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

function broadcastStatus() {
  statusSnapshot()
    .then((status) =>
      chrome.runtime.sendMessage({ type: "status.changed", status })
    )
    .catch(() => {});
}

async function updateBadge() {
  const count = registry.readyCount();
  await chrome.action.setBadgeBackgroundColor({ color: "#F04E30" });
  await chrome.action.setBadgeText({
    text: count > 0 ? String(Math.min(count, 99)) : ""
  });
}
