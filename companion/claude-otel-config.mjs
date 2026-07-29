import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CLAUDE_OTEL_ENVIRONMENT_KEYS = Object.freeze([
  "CLAUDE_CODE_ENABLE_TELEMETRY",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_TRACES_EXPORTER",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_LOGS_EXPORT_INTERVAL",
  "OTEL_LOG_USER_PROMPTS",
  "OTEL_LOG_ASSISTANT_RESPONSES",
  "OTEL_LOG_TOOL_DETAILS",
  "OTEL_LOG_TOOL_CONTENT",
  "OTEL_LOG_RAW_API_BODIES"
]);

export function firstTokSupportDirectory(home = firstTokHome()) {
  return path.join(home, "Library", "Application Support", "FirstTok");
}

export function claudeOtelConfigPath(home = firstTokHome()) {
  return process.env.FIRSTTOK_OTEL_CONFIG_PATH
    ? path.resolve(process.env.FIRSTTOK_OTEL_CONFIG_PATH)
    : path.join(firstTokSupportDirectory(home), "claude-otel.json");
}

export function createClaudeOtelConfig(port) {
  return normalizeClaudeOtelConfig({
    version: 1,
    host: "127.0.0.1",
    port,
    token: crypto.randomBytes(32).toString("hex")
  });
}

export function readClaudeOtelConfig(home = firstTokHome()) {
  try {
    return normalizeClaudeOtelConfig(
      JSON.parse(fs.readFileSync(claudeOtelConfigPath(home), "utf8"))
    );
  } catch {
    return null;
  }
}

export function normalizeClaudeOtelConfig(input) {
  if (
    !input ||
    input.version !== 1 ||
    input.host !== "127.0.0.1" ||
    !Number.isInteger(input.port) ||
    input.port < 1024 ||
    input.port > 65535 ||
    typeof input.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.token)
  ) {
    throw new TypeError("Invalid Go Rot Claude event receiver configuration.");
  }
  return {
    version: 1,
    host: "127.0.0.1",
    port: input.port,
    token: input.token
  };
}

export function claudeOtelEnvironment(config) {
  const normalized = normalizeClaudeOtelConfig(config);
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: "1",
    OTEL_METRICS_EXPORTER: "none",
    OTEL_LOGS_EXPORTER: "otlp",
    OTEL_TRACES_EXPORTER: "none",
    OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT:
      `http://${normalized.host}:${normalized.port}/v1/logs`,
    OTEL_EXPORTER_OTLP_HEADERS:
      `Authorization=Bearer ${normalized.token}`,
    OTEL_LOGS_EXPORT_INTERVAL: "250",
    OTEL_LOG_USER_PROMPTS: "0",
    OTEL_LOG_ASSISTANT_RESPONSES: "0",
    OTEL_LOG_TOOL_DETAILS: "0",
    OTEL_LOG_TOOL_CONTENT: "0",
    OTEL_LOG_RAW_API_BODIES: "0"
  };
}

function firstTokHome() {
  return process.env.FIRSTTOK_HOME
    ? path.resolve(process.env.FIRSTTOK_HOME)
    : os.homedir();
}
