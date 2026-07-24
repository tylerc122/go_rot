export class SessionRegistry {
  #sessions = new Map();
  #ready = new Set();
  #activeKey = null;

  start(key, session) {
    if (this.#sessions.has(key)) {
      return { kind: "duplicate", session: this.#sessions.get(key) };
    }

    if (this.#activeKey === null) {
      this.#activeKey = key;
      this.#sessions.set(key, session);
      return { kind: "active", session };
    }

    session.state = "background";
    this.#sessions.set(key, session);
    return { kind: "background", session };
  }

  terminal(key) {
    const session = this.#sessions.get(key);
    if (!session) return { kind: "missing", session: null };
    if (key === this.#activeKey) return { kind: "active", session };

    this.#sessions.delete(key);
    this.#ready.add(key);
    return { kind: "background", session };
  }

  endSession(agent, sessionId) {
    let active = null;
    for (const [key, session] of this.#sessions) {
      if (
        session.event?.agent !== agent ||
        session.event?.sessionId !== sessionId
      ) {
        continue;
      }
      if (key === this.#activeKey) {
        active = session;
      } else {
        this.#sessions.delete(key);
      }
    }
    return active;
  }

  complete(key) {
    this.#sessions.delete(key);
    if (this.#activeKey === key) this.#activeKey = null;
  }

  active() {
    return this.#activeKey ? this.#sessions.get(this.#activeKey) ?? null : null;
  }

  isActive(key) {
    return this.#activeKey === key;
  }

  readyCount() {
    return this.#ready.size;
  }

  clearReady() {
    this.#ready.clear();
  }
}
