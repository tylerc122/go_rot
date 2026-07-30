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
