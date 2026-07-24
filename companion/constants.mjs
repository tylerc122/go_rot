import os from "node:os";
import path from "node:path";

export const NATIVE_HOST_NAME = "com.firsttok.companion";
export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 1024 * 1024;

export function runtimeDirectory() {
  return process.env.FIRSTTOK_RUNTIME_DIR
    ? path.resolve(process.env.FIRSTTOK_RUNTIME_DIR)
    : path.join(os.tmpdir(), `firsttok-${process.getuid?.() ?? "user"}`);
}

export function socketPath() {
  return path.join(runtimeDirectory(), "companion.sock");
}

export function statePath() {
  return path.join(runtimeDirectory(), "state.json");
}
