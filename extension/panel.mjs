import {
  pauseDeadline,
  setupPresentation,
  statusPresentation
} from "./panel-model.mjs";

const elements = {
  enabled: document.querySelector("#enabled"),
  status: document.querySelector(".status"),
  statusTitle: document.querySelector("#status-title"),
  statusDetail: document.querySelector("#status-detail"),
  reconnect: document.querySelector("#reconnect"),
  setup: document.querySelector("#setup"),
  setupSummary: document.querySelector("#setup-summary"),
  setupReconnect: document.querySelector("#setup-reconnect"),
  setupTestFeed: document.querySelector("#setup-test-feed"),
  setupSteps: [...document.querySelectorAll("[data-setup-step]")],
  readyNotice: document.querySelector("#ready-notice"),
  readyCopy: document.querySelector("#ready-copy"),
  activityHelp: document.querySelector("#activity-help"),
  clearActivity: document.querySelector("#clear-activity"),
  clearReady: document.querySelector("#clear-ready"),
  delay: document.querySelector("#delay"),
  providers: [...document.querySelectorAll("[data-provider]")],
  providerPicker: document.querySelector(".provider-picker"),
  shuffleFeeds: document.querySelector("#shuffle-feeds"),
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
let setupWasComplete = null;

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
    provider.addEventListener("click", async () => {
      const providerId = provider.dataset.provider;
      if (elements.shuffleFeeds.checked) {
        const current = new Set(snapshot?.settings.enabledProviders ?? []);
        if (current.has(providerId)) {
          if (current.size === 1) return;
          current.delete(providerId);
        } else {
          if (feedControlsNeedAccess()) {
            const granted = await requestFeedAccess([providerId]);
            if (!granted) {
              disableFeedControls();
              await updateSettings({
                pauseMedia: false,
                finishCurrentClip: false
              });
            }
          }
          current.add(providerId);
        }
        await updateSettings({ enabledProviders: [...current] });
        return;
      }

      if (feedControlsNeedAccess()) {
        const granted = await requestFeedAccess([providerId]);
        if (!granted) {
          disableFeedControls();
          await updateSettings({
            pauseMedia: false,
            finishCurrentClip: false
          });
        }
      }
      await updateSettings({ provider: providerId });
    });
  }

  elements.shuffleFeeds.addEventListener("change", async () => {
    if (elements.shuffleFeeds.checked && feedControlsNeedAccess()) {
      const providers = snapshot?.settings.enabledProviders ?? activeProviders();
      const granted = await requestFeedAccess(providers);
      if (!granted) {
        disableFeedControls();
        await updateSettings({
          pauseMedia: false,
          finishCurrentClip: false
        });
      }
    }
    await updateSettings({ shuffleFeeds: elements.shuffleFeeds.checked });
  });

  elements.pauseMedia.addEventListener("change", async () => {
    await updateFeedControl("pauseMedia", elements.pauseMedia);
  });

  elements.finishCurrentClip.addEventListener("change", async () => {
    await updateFeedControl("finishCurrentClip", elements.finishCurrentClip);
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

  elements.testFeed.addEventListener("click", () => runFeedTest(elements.testFeed));
  elements.setupTestFeed.addEventListener("click", () =>
    runFeedTest(elements.setupTestFeed)
  );

  elements.return.addEventListener("click", async () => {
    await send({ type: "session.return" });
    await refresh();
  });

  elements.reconnect.addEventListener("click", async () => {
    await send({ type: "companion.reconnect" });
    setTimeout(refresh, 350);
  });

  elements.setupReconnect.addEventListener("click", async () => {
    elements.setupReconnect.disabled = true;
    elements.setupReconnect.textContent = "Retrying";
    await send({ type: "companion.reconnect" });
    setTimeout(async () => {
      await refresh();
      elements.setupReconnect.disabled = false;
      elements.setupReconnect.textContent = "Retry";
    }, 350);
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
  return settingsWrite;
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
  elements.shuffleFeeds.checked = settings.shuffleFeeds;
  elements.pauseMedia.checked = settings.pauseMedia;
  elements.finishCurrentClip.checked = settings.finishCurrentClip;
  for (const provider of elements.providers) {
    const selected = settings.shuffleFeeds
      ? settings.enabledProviders.includes(provider.dataset.provider)
      : provider.dataset.provider === settings.provider;
    provider.setAttribute("aria-pressed", String(selected));
  }
  elements.providerPicker.dataset.mode = settings.shuffleFeeds ? "shuffle" : "fixed";

  elements.status.dataset.tone = status.tone;
  elements.statusTitle.textContent = status.title;
  elements.statusDetail.textContent = status.detail;
  elements.reconnect.hidden = next.connectionState !== "disconnected";
  elements.testFeed.disabled = next.connectionState !== "connected";
  elements.setupTestFeed.disabled = next.connectionState !== "connected";
  elements.return.disabled = !(next.feedSession ?? next.activeSession);

  const setup = setupPresentation(next);
  elements.setupSummary.textContent = setup.complete
    ? "Setup complete"
    : `${setup.completedCount} of ${setup.items.length} ready`;
  for (const step of elements.setupSteps) {
    const item = setup.items.find((candidate) => candidate.id === step.dataset.setupStep);
    step.dataset.complete = String(item?.complete === true);
    const detail = step.querySelector("[data-setup-detail]");
    if (detail && item) detail.textContent = item.detail;
  }
  elements.setupReconnect.hidden = setup.items.find(
    (item) => item.id === "companion"
  )?.complete;
  elements.setupTestFeed.hidden = setup.items.find(
    (item) => item.id === "feed"
  )?.complete;
  if (!setup.complete) {
    elements.setup.open = true;
  } else if (setupWasComplete !== true) {
    elements.setup.open = false;
  }
  setupWasComplete = setup.complete;

  const activity = next.activity ?? {
    working: next.activeSession ? 1 : 0,
    attention: 0,
    ready: next.backgroundReady ?? 0
  };
  const activityParts = [];
  if (activity.working > 0) activityParts.push(`${activity.working} cooking`);
  if (activity.attention > 0) activityParts.push(`${activity.attention} needs you`);
  if (activity.ready > 0) activityParts.push(`${activity.ready} cooked`);
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

async function runFeedTest(button) {
  if (feedControlsNeedAccess()) {
    const granted = await requestFeedAccess(activeProviders());
    if (!granted) {
      disableFeedControls();
      await updateSettings({
        pauseMedia: false,
        finishCurrentClip: false
      });
    }
  }
  button.disabled = true;
  button.textContent = "Opening feed";
  const result = await send({ type: "feed.test" });
  button.textContent = result.ok ? "Feed works" : "Could not connect";
  await refresh();
  setTimeout(() => {
    button.textContent = button === elements.testFeed
      ? "Run feed check"
      : "Test feed";
    button.disabled = snapshot?.connectionState !== "connected";
  }, 2200);
}

async function updateFeedControl(key, element) {
  if (!element.checked) {
    await updateSettings({ [key]: false });
    return;
  }
  const granted = await requestFeedAccess(activeProviders());
  element.checked = granted;
  await updateSettings({ [key]: granted });
}

function activeProviders() {
  const settings = snapshot?.settings;
  if (!settings) return ["youtube"];
  return settings.shuffleFeeds
    ? settings.enabledProviders
    : [settings.provider];
}

function feedControlsNeedAccess() {
  return elements.pauseMedia.checked || elements.finishCurrentClip.checked;
}

function disableFeedControls() {
  elements.pauseMedia.checked = false;
  elements.finishCurrentClip.checked = false;
}

async function requestFeedAccess(providers) {
  const origins = {
    youtube: ["https://www.youtube.com/*"],
    tiktok: ["https://www.tiktok.com/*"],
    instagram: ["https://www.instagram.com/*"]
  };
  try {
    return await chrome.permissions.request({
      origins: [...new Set(providers.flatMap((provider) => origins[provider] ?? []))]
    });
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
