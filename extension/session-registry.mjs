export class SessionRegistry {
  #tasks = new Map();

  start(key, task) {
    const existing = this.#tasks.get(key);
    if (existing?.state === "working") {
      return { kind: "duplicate", task: existing };
    }

    const resumed = [];
    for (const [candidateKey, candidate] of this.#tasks) {
      if (
        candidate.state === "attention" &&
        sameProviderSession(candidate.event, task.event)
      ) {
        this.#tasks.delete(candidateKey);
        resumed.push(candidate);
      }
    }

    task.state = "working";
    this.#tasks.set(key, task);
    return {
      kind: existing || resumed.length > 0 ? "resumed" : "started",
      task,
      resumed
    };
  }

  resume(key, event) {
    const exact = this.#tasks.get(key);
    if (exact) {
      const previousState = exact.state;
      exact.event = { ...exact.event, ...event };
      if (previousState !== "attention") {
        return { kind: "unchanged", task: exact };
      }
      exact.state = "working";
      delete exact.attentionReason;
      return { kind: "resumed", task: exact };
    }

    for (const task of this.#tasks.values()) {
      if (
        task.state === "attention" &&
        sameProviderSession(task.event, event)
      ) {
        task.state = "working";
        delete task.attentionReason;
        return { kind: "resumed", task };
      }
    }
    return { kind: "missing", task: null };
  }

  requireAttention(key, event) {
    let task = this.#tasks.get(key);
    const kind = task ? "attention" : "recovered";
    if (!task) {
      task = {
        key,
        event,
        state: "attention",
        startedAt: event.timestamp ?? Date.now()
      };
      this.#tasks.set(key, task);
    }
    task.event = { ...task.event, ...event };
    task.state = "attention";
    task.attentionReason = event.reason;
    return { kind, task };
  }

  complete(key, event) {
    let task = this.#tasks.get(key);
    const kind = task ? "completed" : "recovered";
    if (!task) {
      task = {
        key,
        event,
        startedAt: event.timestamp ?? Date.now()
      };
      this.#tasks.set(key, task);
    }
    task.event = { ...task.event, ...event };
    task.state = "ready";
    task.completedAt = event.timestamp ?? Date.now();
    delete task.attentionReason;
    return { kind, task };
  }

  endSession(agent, sessionId) {
    const removed = [];
    for (const [key, task] of this.#tasks) {
      if (
        task.event?.agent === agent &&
        task.event?.sessionId === sessionId
      ) {
        removed.push(task);
        this.#tasks.delete(key);
      }
    }
    return removed;
  }

  counts() {
    const counts = { working: 0, attention: 0, ready: 0 };
    for (const task of this.#tasks.values()) {
      if (task.state in counts) counts[task.state] += 1;
    }
    return counts;
  }

  pendingCount() {
    const { working, attention } = this.counts();
    return working + attention;
  }

  latestAttention() {
    return [...this.#tasks.values()]
      .filter((task) => task.state === "attention")
      .sort((a, b) => (b.event?.timestamp ?? 0) - (a.event?.timestamp ?? 0))[0] ?? null;
  }

  clearReady() {
    for (const [key, task] of this.#tasks) {
      if (task.state === "ready") this.#tasks.delete(key);
    }
  }

  clearAll() {
    const removed = [...this.#tasks.values()];
    this.#tasks.clear();
    return removed;
  }

  tasks() {
    return [...this.#tasks.values()];
  }
}

function sameProviderSession(left, right) {
  return Boolean(
    left &&
      right &&
      left.agent === right.agent &&
      left.sessionId === right.sessionId
  );
}
