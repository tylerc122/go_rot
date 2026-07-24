import { PROTOCOL_VERSION } from "./constants.mjs";

const AGENTS = new Set(["claude-code", "codex"]);
const SURFACES = new Set(["cli", "desktop"]);
const EVENT_TYPES = new Set([
  "work.started",
  "attention.required",
  "work.completed",
  "session.ended"
]);
const ATTENTION_REASONS = new Set(["permission", "question", "error"]);

export function normalizeLifecycleEvent(input, defaults = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("Lifecycle event must be an object.");
  }

  const event = {
    protocolVersion: PROTOCOL_VERSION,
    type: input.type,
    agent: input.agent ?? defaults.agent,
    surface: input.surface ?? defaults.surface,
    sessionId: stringOrFallback(input.sessionId, defaults.sessionId, "unknown-session"),
    turnId: stringOrFallback(input.turnId, defaults.turnId, "unknown-turn"),
    sourceApp: stringOrFallback(input.sourceApp, defaults.sourceApp, null),
    timestamp: finiteNumber(input.timestamp) ? input.timestamp : Date.now()
  };

  if (!EVENT_TYPES.has(event.type)) {
    throw new TypeError(`Unsupported lifecycle event: ${String(event.type)}`);
  }
  if (!AGENTS.has(event.agent)) {
    throw new TypeError(`Unsupported agent: ${String(event.agent)}`);
  }
  if (!SURFACES.has(event.surface)) {
    throw new TypeError(`Unsupported surface: ${String(event.surface)}`);
  }

  if (event.type === "attention.required") {
    event.reason = input.reason ?? defaults.reason;
    if (!ATTENTION_REASONS.has(event.reason)) {
      throw new TypeError(`Unsupported attention reason: ${String(event.reason)}`);
    }
  }

  return event;
}

export function lifecycleEventFromHook(input, options) {
  const hookName = String(
    input?.hook_event_name ??
      input?.hookEventName ??
      input?.event_name ??
      input?.eventName ??
      ""
  );

  const mapped = mapHookName(hookName, input);
  if (!mapped) {
    return null;
  }

  return normalizeLifecycleEvent(
    {
      ...mapped,
      agent: options.agent,
      surface: options.surface,
      sessionId: input?.session_id ?? input?.sessionId,
      turnId: input?.turn_id ?? input?.turnId,
      sourceApp: options.sourceApp,
      timestamp: Date.now()
    },
    options
  );
}

export function detectSurface(agent, env = process.env, input = {}) {
  if (env.FIRSTTOK_SURFACE === "cli" || env.FIRSTTOK_SURFACE === "desktop") {
    return env.FIRSTTOK_SURFACE;
  }
  const clientId = String(input.client_id ?? input.clientId ?? "").toLowerCase();
  if (/(desktop|codex[_-]?app|chatgpt|claude[_-]?app)/.test(clientId)) {
    return "desktop";
  }
  if (/(cli|tui|terminal)/.test(clientId)) {
    return "cli";
  }
  if (env.TERM_PROGRAM || env.TERM || env.TTY) {
    return "cli";
  }
  return "desktop";
}

export function detectSourceApp(agent, surface, env = process.env) {
  if (env.FIRSTTOK_SOURCE_APP) {
    return env.FIRSTTOK_SOURCE_APP;
  }
  if (surface === "desktop") {
    return agent === "claude-code" ? "Claude" : "Codex";
  }

  const terminal = String(env.TERM_PROGRAM ?? "").toLowerCase();
  if (terminal.includes("iterm")) return "iTerm";
  if (terminal.includes("apple_terminal")) return "Terminal";
  if (terminal.includes("warp")) return "Warp";
  if (terminal.includes("wezterm")) return "WezTerm";
  if (terminal.includes("ghostty")) return "Ghostty";
  if (terminal.includes("vscode")) return "Visual Studio Code";
  return "Terminal";
}

function mapHookName(hookName, input) {
  switch (hookName) {
    case "UserPromptSubmit":
      return { type: "work.started" };
    case "PermissionRequest":
      return { type: "attention.required", reason: "permission" };
    case "Notification":
      if (input?.notification_type === "permission_prompt") {
        return { type: "attention.required", reason: "permission" };
      }
      if (input?.notification_type === "idle_prompt") {
        return { type: "attention.required", reason: "question" };
      }
      return null;
    case "Stop":
      return { type: "work.completed" };
    case "SessionEnd":
      return { type: "session.ended" };
    default:
      return null;
  }
}

function stringOrFallback(value, fallback, finalFallback) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof fallback === "string" && fallback.length > 0) return fallback;
  return finalFallback;
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}
