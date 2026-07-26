import { pauseDeadline, statusPresentation } from "./panel-model.mjs";

const elements = {
  enabled: document.querySelector("#enabled"),
  status: document.querySelector(".status"),
  statusTitle: document.querySelector("#status-title"),
  statusDetail: document.querySelector("#status-detail"),
  reconnect: document.querySelector("#reconnect"),
  readyNotice: document.querySelector("#ready-notice"),
  readyCopy: document.querySelector("#ready-copy"),
  activityHelp: document.querySelector("#activity-help"),
  clearActivity: document.querySelector("#clear-activity"),
  clearReady: document.querySelector("#clear-ready"),
  delay: document.querySelector("#delay"),
  providers: [...document.querySelectorAll('input[name="provider"]')],
  testFeed: document.querySelector("#test-feed"),
  pauseMedia: document.querySelector("#pause-media"),
  finishCurrentClip: document.querySelector("#finish-current-clip"),
  pauseDetail: document.querySelector("#pause-detail"),
  pauseControls: document.querySelector("#pause-controls"),
  pauseDuration: document.querySelector("#pause-duration"),
  pause: document.querySelector("#pause"),
  resume: document.querySelector("#resume"),
  agentClaude: document.querySelector("#agent-claude"),
  agentCodex: document.querySelector("#agent-codex"),
  return: document.querySelector("#return")
};

let snapshot = null;
let settingsWrite = Promise.resolve();

bindEvents();
await refresh();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "status.changed") {
    render(message.status);
  }
});

function bindEvents() {
  elements.enabled.addEventListener("change", () => {
    updateSettings({ enabled: elements.enabled.checked });
  });

  elements.delay.addEventListener("change", () => {
    updateSettings({ delayMs: Number(elements.delay.value) });
  });

  for (const provider of elements.providers) {
    provider.addEventListener("change", async () => {
      if (!provider.checked) return;
      let pauseMedia = elements.pauseMedia.checked;
      let finishCurrentClip = elements.finishCurrentClip.checked;
      if (pauseMedia || finishCurrentClip) {
        const granted = await requestFeedAccess(provider.value);
        if (!granted) {
          pauseMedia = false;
          finishCurrentClip = false;
          elements.pauseMedia.checked = false;
          elements.finishCurrentClip.checked = false;
        }
      }
      updateSettings({
        provider: provider.value,
        pauseMedia,
        finishCurrentClip
      });
    });
  }

  elements.pauseMedia.addEventListener("change", async () => {
    if (!elements.pauseMedia.checked) {
      updateSettings({ pauseMedia: false });
      return;
    }
    const granted = await requestFeedAccess(selectedProvider());
    elements.pauseMedia.checked = granted;
    updateSettings({ pauseMedia: granted });
  });

  elements.finishCurrentClip.addEventListener("change", async () => {
    if (!elements.finishCurrentClip.checked) {
      updateSettings({ finishCurrentClip: false });
      return;
    }
    const granted = await requestFeedAccess(selectedProvider());
    elements.finishCurrentClip.checked = granted;
    updateSettings({ finishCurrentClip: granted });
  });

  elements.agentClaude.addEventListener("change", updateAgents);
  elements.agentCodex.addEventListener("change", updateAgents);

  elements.pause.addEventListener("click", () => {
    updateSettings({
      pausedUntil: pauseDeadline(elements.pauseDuration.value)
    });
  });

  elements.resume.addEventListener("click", () => {
    updateSettings({ pausedUntil: 0 });
  });

  elements.testFeed.addEventListener("click", async () => {
    elements.testFeed.disabled = true;
    elements.testFeed.textContent = "Opening…";
    const result = await send({ type: "feed.test" });
    elements.testFeed.textContent = result.ok
      ? "Connection verified"
      : "Companion not connected";
    setTimeout(() => {
      elements.testFeed.textContent = "Test connection + feed";
      elements.testFeed.disabled = snapshot?.connectionState !== "connected";
    }, 2200);
  });

  elements.return.addEventListener("click", async () => {
    await send({ type: "session.return" });
    await refresh();
  });

  elements.reconnect.addEventListener("click", async () => {
    await send({ type: "companion.reconnect" });
    setTimeout(refresh, 350);
  });

  elements.clearReady.addEventListener("click", async () => {
    await send({ type: "background.clear" });
    await refresh();
  });

  elements.clearActivity.addEventListener("click", async () => {
    elements.clearActivity.disabled = true;
    elements.clearActivity.textContent = "Clearing…";
    await send({ type: "activity.reset" });
    await refresh();
    elements.clearActivity.disabled = false;
    elements.clearActivity.textContent = "Clear stuck";
  });
}

function updateAgents() {
  updateSettings({
    agents: {
      "claude-code": elements.agentClaude.checked,
      codex: elements.agentCodex.checked
    }
  });
}

function updateSettings(patch) {
  settingsWrite = settingsWrite
    .then(() => send({ type: "settings.update", settings: patch }))
    .then((result) => {
      if (result.ok && snapshot) {
        render({ ...snapshot, settings: result.settings });
      }
    })
    .catch(() => {});
}

async function refresh() {
  const result = await send({ type: "status.get" });
  if (result.ok) render(result);
}

function render(next) {
  snapshot = next;
  const settings = next.settings;
  const status = statusPresentation(next);
  const paused = settings.pausedUntil > Date.now();

  elements.enabled.checked = settings.enabled;
  elements.delay.value = String(settings.delayMs);
  elements.agentClaude.checked = settings.agents["claude-code"];
  elements.agentCodex.checked = settings.agents.codex;
  elements.pauseMedia.checked = settings.pauseMedia;
  elements.finishCurrentClip.checked = settings.finishCurrentClip;
  for (const provider of elements.providers) {
    provider.checked = provider.value === settings.provider;
  }

  elements.status.dataset.tone = status.tone;
  elements.statusTitle.textContent = status.title;
  elements.statusDetail.textContent = status.detail;
  elements.reconnect.hidden = next.connectionState !== "disconnected";
  elements.testFeed.disabled = next.connectionState !== "connected";
  elements.return.disabled = !(next.feedSession ?? next.activeSession);

  const activity = next.activity ?? {
    working: next.activeSession ? 1 : 0,
    attention: 0,
    ready: next.backgroundReady ?? 0
  };
  const activityParts = [];
  if (activity.working > 0) activityParts.push(`${activity.working} working`);
  if (activity.attention > 0) activityParts.push(`${activity.attention} needs you`);
  if (activity.ready > 0) activityParts.push(`${activity.ready} ready`);
  elements.readyNotice.hidden = activityParts.length === 0;
  elements.readyNotice.dataset.tone =
    activity.attention > 0 ? "attention" : activity.working > 0 ? "working" : "ready";
  elements.readyCopy.textContent = activityParts.join(" · ");
  const hasPendingActivity = activity.working + activity.attention > 0;
  elements.activityHelp.hidden = !hasPendingActivity;
  elements.clearActivity.hidden = !hasPendingActivity;
  elements.clearReady.hidden = hasPendingActivity || activity.ready === 0;

  elements.pauseControls.hidden = paused;
  elements.resume.hidden = !paused;
  elements.pauseDetail.textContent = paused
    ? status.detail
    : "Temporarily ignore new work.";
}

function selectedProvider() {
  return elements.providers.find((provider) => provider.checked)?.value ?? "youtube";
}

async function requestFeedAccess(provider) {
  const origins = {
    youtube: ["https://www.youtube.com/*"],
    tiktok: ["https://www.tiktok.com/*"],
    instagram: ["https://www.instagram.com/*"]
  };
  try {
    return await chrome.permissions.request({ origins: origins[provider] });
  } catch {
    return false;
  }
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
