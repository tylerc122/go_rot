export function pauseDeadline(option, now = new Date()) {
  const timestamp = now.getTime();
  if (option === "15m") return timestamp + 15 * 60 * 1000;
  if (option === "1h") return timestamp + 60 * 60 * 1000;
  if (option === "tomorrow") {
    const tomorrow = new Date(timestamp);
    tomorrow.setHours(24, 0, 0, 0);
    return tomorrow.getTime();
  }
  return 0;
}

export function statusPresentation(snapshot, now = Date.now()) {
  const settings = snapshot?.settings;
  const activity = {
    working: snapshot?.activity?.working ?? 0,
    attention: snapshot?.activity?.attention ?? 0,
    ready: snapshot?.activity?.ready ?? snapshot?.backgroundReady ?? 0
  };
  if (!settings?.enabled) {
    return {
      tone: "muted",
      title: "FirstTok is off",
      detail: "Agent events are ignored until you turn it back on."
    };
  }

  if (settings.pausedUntil > now) {
    return {
      tone: "paused",
      title: "Paused",
      detail: `Resumes ${formatTime(settings.pausedUntil)}.`
    };
  }

  if (activity.attention > 0) {
    const attentionSession = snapshot?.feedSession ?? snapshot?.activeSession;
    const agent = attentionSession?.agent
      ? agentLabel(attentionSession.agent)
      : "Your agent";
    return {
      tone: "attention",
      title: `${agent} needs you`,
      detail:
        activity.attention === 1
          ? "Feed parked at the same video."
          : `${activity.attention} tasks are waiting for input.`
    };
  }

  if (snapshot?.feedSession ?? snapshot?.activeSession) {
    const session = snapshot.feedSession ?? snapshot.activeSession;
    const agent = session.agent ? agentLabel(session.agent) : "Your agent";
    const state = session.state;
    if (state === "finishing") {
      return {
        tone: "ready",
        title: "Agent ready",
        detail: "Finishing this clip, then returning."
      };
    }
    const title =
      activity.working > 1
        ? `${activity.working} tasks working`
        : `${agent} is working`;
    return {
      tone: "active",
      title,
      detail:
        state === "active"
          ? "Your feed is open."
          : state === "waiting"
            ? "Waiting for the launch delay."
            : state === "parked"
              ? "Feed parked at the same video."
              : "Opening your feed."
    };
  }

  if (activity.working > 0) {
    return {
      tone: "active",
      title:
        activity.working === 1
          ? "1 task working"
          : `${activity.working} tasks working`,
      detail: "The feed was closed for this round."
    };
  }

  if (snapshot?.connectionState === "disconnected") {
    return {
      tone: "error",
      title: "Companion unavailable",
      detail: cleanError(snapshot.lastError)
    };
  }

  if (snapshot?.connectionState !== "connected") {
    return {
      tone: "connecting",
      title: "Connecting",
      detail: "Starting the local companion."
    };
  }

  return {
    tone: "ready",
    title: "Ready",
    detail: "Listening for Claude Code and Codex."
  };
}

export function setupPresentation(snapshot) {
  const settings = snapshot?.settings ?? {};
  const observedAgents = settings.observedAgents ?? {};
  const observed = Object.entries(observedAgents)
    .filter(([, timestamp]) => Number.isFinite(timestamp) && timestamp > 0)
    .map(([agent]) => agentLabel(agent));
  const items = [
    {
      id: "companion",
      complete: snapshot?.connectionState === "connected",
      title: "Local companion",
      detail:
        snapshot?.connectionState === "connected"
          ? "Connected"
          : "Install or reconnect the companion"
    },
    {
      id: "feed",
      complete: settings.feedTested === true,
      title: "Feed check",
      detail: settings.feedTested
        ? "Feed opened successfully"
        : "Open your selected feed once"
    },
    {
      id: "agent",
      complete: observed.length > 0,
      title: "Agent signal",
      detail:
        observed.length > 0
          ? `${observed.join(" + ")} detected`
          : "Run one Codex or Claude task"
    }
  ];
  return {
    complete: items.every((item) => item.complete),
    completedCount: items.filter((item) => item.complete).length,
    items
  };
}

export function agentLabel(agent) {
  return agent === "claude-code" ? "Claude Code" : "Codex";
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(timestamp);
}

function cleanError(error) {
  if (typeof error !== "string" || !error.trim()) {
    return "Run the installer or reconnect the local companion.";
  }
  return error
    .replace(/^Error when communicating with the native messaging host:\s*/i, "")
    .replace(/\.$/, "");
}
