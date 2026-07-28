const WINDOW_MARGIN = 24;

export function resolveFeedBounds(settings, displays, anchorWindow) {
  const activeDisplays = normalizedDisplays(displays);
  const preferred = activeDisplays.find(
    (display) => display.id === settings.windowDisplayId
  );
  const display =
    preferred ??
    displayContaining(activeDisplays, centerOf(anchorWindow)) ??
    activeDisplays.find((candidate) => candidate.isPrimary) ??
    activeDisplays[0] ??
    fallbackDisplay(anchorWindow);
  const area = display.workArea ?? display.bounds;
  const width = Math.min(settings.windowWidth, area.width);
  const height = Math.min(settings.windowHeight, area.height);
  const remembered =
    Boolean(preferred) &&
    Number.isFinite(settings.windowLeft) &&
    Number.isFinite(settings.windowTop);
  const defaultLeft = area.left + Math.max(0, area.width - width - WINDOW_MARGIN);
  const defaultTop = area.top + Math.max(0, Math.round((area.height - height) / 2));

  return {
    displayId: display.id,
    left: clamp(
      remembered ? settings.windowLeft : defaultLeft,
      area.left,
      area.left + Math.max(0, area.width - width)
    ),
    top: clamp(
      remembered ? settings.windowTop : defaultTop,
      area.top,
      area.top + Math.max(0, area.height - height)
    ),
    width,
    height
  };
}

export function captureWindowPlacement(window, displays) {
  if (!hasBounds(window) || window.state && window.state !== "normal") return null;
  const activeDisplays = normalizedDisplays(displays);
  const center = centerOf(window);
  const display =
    displayContaining(activeDisplays, center) ??
    displayWithLargestIntersection(activeDisplays, window) ??
    activeDisplays.find((candidate) => candidate.isPrimary) ??
    activeDisplays[0];
  if (!display) return null;
  return {
    windowLeft: Math.round(window.left),
    windowTop: Math.round(window.top),
    windowWidth: Math.round(window.width),
    windowHeight: Math.round(window.height),
    windowDisplayId: display.id
  };
}

function normalizedDisplays(displays) {
  if (!Array.isArray(displays)) return [];
  return displays.filter(
    (display) =>
      display &&
      display.id !== undefined &&
      display.isEnabled !== false &&
      display.activeState !== "inactive" &&
      hasBounds(display.workArea ?? display.bounds)
  );
}

function displayContaining(displays, point) {
  if (!point) return null;
  return displays.find((display) => {
    const area = display.workArea ?? display.bounds;
    return (
      point.x >= area.left &&
      point.x < area.left + area.width &&
      point.y >= area.top &&
      point.y < area.top + area.height
    );
  });
}

function displayWithLargestIntersection(displays, window) {
  let winner = null;
  let winnerArea = 0;
  for (const display of displays) {
    const area = display.workArea ?? display.bounds;
    const width = Math.max(
      0,
      Math.min(window.left + window.width, area.left + area.width) -
        Math.max(window.left, area.left)
    );
    const height = Math.max(
      0,
      Math.min(window.top + window.height, area.top + area.height) -
        Math.max(window.top, area.top)
    );
    if (width * height > winnerArea) {
      winner = display;
      winnerArea = width * height;
    }
  }
  return winner;
}

function fallbackDisplay(anchorWindow) {
  const bounds = hasBounds(anchorWindow)
    ? {
        left: anchorWindow.left,
        top: anchorWindow.top,
        width: anchorWindow.width,
        height: anchorWindow.height
      }
    : { left: 0, top: 0, width: 1440, height: 900 };
  return { id: "fallback", isPrimary: true, bounds, workArea: bounds };
}

function centerOf(value) {
  if (!hasBounds(value)) return null;
  return {
    x: value.left + value.width / 2,
    y: value.top + value.height / 2
  };
}

function hasBounds(value) {
  return Boolean(
    value &&
      Number.isFinite(value.left) &&
      Number.isFinite(value.top) &&
      Number.isFinite(value.width) &&
      Number.isFinite(value.height) &&
      value.width > 0 &&
      value.height > 0
  );
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, Math.round(value)));
}
