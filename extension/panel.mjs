import { pauseDeadline, statusPresentation } from "./panel-model.mjs";

const elements = {
  enabled: document.querySelector("#enabled"),
  status: document.querySelector(".status"),
  statusTitle: document.querySelector("#status-title"),
  statusDetail: document.querySelector("#status-detail"),
  reconnect: document.querySelector("#reconnect"),
  readyNotice: document.querySelector("#ready-notice"),
  readyCopy: document.querySelector("#ready-copy"),
  clearReady: document.querySelector("#clear-ready"),
  delay: document.querySelector("#delay"),
  providers: [...document.querySelectorAll('input[name="provider"]')],
  testFeed: document.querySelector("#test-feed"),
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
    provider.addEventListener("change", () => {
      if (provider.checked) updateSettings({ provider: provider.value });
    });
  }

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
  for (const provider of elements.providers) {
    provider.checked = provider.value === settings.provider;
  }

  elements.status.dataset.tone = status.tone;
  elements.statusTitle.textContent = status.title;
  elements.statusDetail.textContent = status.detail;
  elements.reconnect.hidden = next.connectionState !== "disconnected";
  elements.testFeed.disabled = next.connectionState !== "connected";
  elements.return.disabled = !next.activeSession;

  elements.readyNotice.hidden = next.backgroundReady === 0;
  elements.readyCopy.textContent =
    next.backgroundReady === 1
      ? "1 background turn is ready."
      : `${next.backgroundReady} background turns are ready.`;

  elements.pauseControls.hidden = paused;
  elements.resume.hidden = !paused;
  elements.pauseDetail.textContent = paused
    ? status.detail
    : "Temporarily ignore new work.";
}

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    return { ok: false, error: error.message };
  }
}
