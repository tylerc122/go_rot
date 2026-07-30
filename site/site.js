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

for (const link of document.querySelectorAll("[data-release-link]")) {
  link.addEventListener("click", (event) => {
    if (link.getAttribute("aria-disabled") === "true") {
      event.preventDefault();
    }
  });
}

configureReleaseLinks();

async function configureReleaseLinks() {
  try {
    const response = await fetch("release.json", { cache: "no-store" });
    if (!response.ok) return;
    const release = await response.json();
    const links = {
      mac: release.macDownloadUrl,
      chrome: release.chromeStoreUrl,
    };

    if (!Object.values(links).every(isHttpsUrl)) return;

    enableReleaseLink("mac", links.mac);
    enableReleaseLink("chrome", links.chrome);
    document.querySelector("[data-release-status]")?.setAttribute("hidden", "");
  } catch {
    // Local file previews cannot fetch release.json. Disabled links remain clear.
  }
}

function isHttpsUrl(url) {
  return typeof url === "string" && url.startsWith("https://");
}

function enableReleaseLink(kind, url) {
  const link = document.querySelector(`[data-release-link="${kind}"]`);
  if (!link) return;
  link.href = url;
  link.removeAttribute("aria-disabled");
}
