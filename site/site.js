const video = document.querySelector("#demo-video");
const toggle = document.querySelector(".video-toggle");
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function syncToggle() {
  const isPaused = video.paused;
  toggle.dataset.state = isPaused ? "paused" : "playing";
  toggle.setAttribute("aria-label", isPaused ? "Play demo" : "Pause demo");
}

function applyMotionPreference() {
  if (reducedMotion.matches) {
    video.pause();
  }
  syncToggle();
}

toggle.addEventListener("click", async () => {
  if (video.paused) {
    await video.play();
  } else {
    video.pause();
  }
});

video.addEventListener("play", syncToggle);
video.addEventListener("pause", syncToggle);
reducedMotion.addEventListener("change", applyMotionPreference);
applyMotionPreference();

for (const link of document.querySelectorAll('[data-release-link][aria-disabled="true"]')) {
  link.addEventListener("click", (event) => event.preventDefault());
}

configureReleaseLinks();

async function configureReleaseLinks() {
  try {
    const response = await fetch("release.json", { cache: "no-store" });
    if (!response.ok) return;
    const release = await response.json();
    enableReleaseLink("mac", release.macDownloadUrl, `v${release.version}`);
    enableReleaseLink("chrome", release.chromeStoreUrl, "store");
  } catch {
    // Local file previews cannot fetch release.json. Disabled links remain clear.
  }
}

function enableReleaseLink(kind, url, badge) {
  if (typeof url !== "string" || !url.startsWith("https://")) return;
  const link = document.querySelector(`[data-release-link="${kind}"]`);
  if (!link) return;
  link.href = url;
  link.removeAttribute("aria-disabled");
  link.querySelector("[data-release-badge]").textContent = badge;
}
