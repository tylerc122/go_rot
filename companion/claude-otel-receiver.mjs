import crypto from "node:crypto";
import http from "node:http";
import { MAX_MESSAGE_BYTES } from "./constants.mjs";
import { normalizeClaudeOtelConfig } from "./claude-otel-config.mjs";

const USER_DECISION_SOURCES = new Set([
  "user_abort",
  "user_permanent",
  "user_reject",
  "user_temporary"
]);

export async function startClaudeOtelReceiver({
  config,
  onDecision,
  onPrompt = () => {},
  onEvent = () => {},
  maximumBytes = MAX_MESSAGE_BYTES
}) {
  const normalized = normalizeClaudeOtelConfig(config);
  const seen = new Set();
  const server = http.createServer((request, response) => {
    handleRequest(request, response, {
      config: normalized,
      maximumBytes,
      onEvent(event) {
        const key = [
          "event",
          event.sessionId,
          event.sequence,
          event.eventName
        ].join(":");
        if (seen.has(key)) return;
        onEvent(event);
        seen.add(key);
        if (seen.size > 512) seen.delete(seen.values().next().value);
      },
      onDecision(decision) {
        const key = [
          decision.sessionId,
          decision.sequence,
          decision.toolUseId,
          decision.decision
        ].join(":");
        if (seen.has(key)) return;
        onDecision(decision);
        seen.add(key);
        if (seen.size > 512) seen.delete(seen.values().next().value);
      },
      onPrompt(prompt) {
        const key = [
          "prompt",
          prompt.sessionId,
          prompt.sequence
        ].join(":");
        if (seen.has(key)) return;
        onPrompt(prompt);
        seen.add(key);
        if (seen.size > 512) seen.delete(seen.values().next().value);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(normalized.port, normalized.host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    address: `http://${normalized.host}:${normalized.port}`,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      })
  };
}

export function extractClaudeEventSummaries(payload) {
  const events = [];
  for (const resourceLog of array(payload?.resourceLogs)) {
    const resourceAttributes = attributesToObject(
      resourceLog?.resource?.attributes
    );
    for (const scopeLog of array(resourceLog?.scopeLogs)) {
      for (const record of array(scopeLog?.logRecords)) {
        const attributes = {
          ...resourceAttributes,
          ...attributesToObject(record?.attributes)
        };
        const eventName =
          stringValue(attributes["event.name"]) ??
          stringValue(record?.body?.stringValue);
        const sessionId = stringValue(attributes["session.id"]);
        if (!eventName || !sessionId) continue;
        events.push({
          eventName,
          sessionId,
          sequence: stringValue(attributes["event.sequence"]) ?? "unknown",
          promptId: stringValue(attributes["prompt.id"]),
          querySource: querySourceCategory(
            stringValue(attributes.query_source)
          ),
          timestamp: eventTimestamp(attributes, record)
        });
      }
    }
  }
  return events;
}

export function extractClaudeToolDecisions(payload) {
  const decisions = [];
  for (const resourceLog of array(payload?.resourceLogs)) {
    const resourceAttributes = attributesToObject(
      resourceLog?.resource?.attributes
    );
    for (const scopeLog of array(resourceLog?.scopeLogs)) {
      for (const record of array(scopeLog?.logRecords)) {
        const attributes = {
          ...resourceAttributes,
          ...attributesToObject(record?.attributes)
        };
        const eventName =
          stringValue(attributes["event.name"]) ??
          stringValue(record?.body?.stringValue);
        if (
          eventName !== "tool_decision" &&
          eventName !== "claude_code.tool_decision"
        ) {
          continue;
        }

        const sessionId = stringValue(attributes["session.id"]);
        const decision = stringValue(attributes.decision);
        const source = stringValue(attributes.source);
        if (
          !sessionId ||
          !["accept", "reject"].includes(decision) ||
          !USER_DECISION_SOURCES.has(source)
        ) {
          continue;
        }

        decisions.push({
          sessionId,
          decision,
          source,
          toolUseId: stringValue(attributes.tool_use_id) ?? "unknown-tool",
          sequence: stringValue(attributes["event.sequence"]) ?? "unknown",
          promptId: stringValue(attributes["prompt.id"]),
          serviceName: stringValue(attributes["service.name"]) ?? "claude-code",
          terminalType: stringValue(attributes["terminal.type"]),
          timestamp: eventTimestamp(attributes, record)
        });
      }
    }
  }
  return decisions;
}

export function extractClaudeUserPrompts(payload) {
  const prompts = [];
  for (const resourceLog of array(payload?.resourceLogs)) {
    const resourceAttributes = attributesToObject(
      resourceLog?.resource?.attributes
    );
    for (const scopeLog of array(resourceLog?.scopeLogs)) {
      for (const record of array(scopeLog?.logRecords)) {
        const attributes = {
          ...resourceAttributes,
          ...attributesToObject(record?.attributes)
        };
        const eventName =
          stringValue(attributes["event.name"]) ??
          stringValue(record?.body?.stringValue);
        if (
          eventName !== "user_prompt" &&
          eventName !== "claude_code.user_prompt"
        ) {
          continue;
        }

        const sessionId = stringValue(attributes["session.id"]);
        if (!sessionId) continue;
        prompts.push({
          sessionId,
          sequence: stringValue(attributes["event.sequence"]) ?? "unknown",
          serviceName: stringValue(attributes["service.name"]) ?? "claude-code",
          terminalType: stringValue(attributes["terminal.type"]),
          timestamp: eventTimestamp(attributes, record)
        });
      }
    }
  }
  return prompts;
}

async function handleRequest(request, response, options) {
  response.setHeader("Cache-Control", "no-store");
  if (request.method === "GET" && request.url === "/health") {
    if (!authorized(request, options.config.token)) {
      response.writeHead(401).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200).end('{"ok":true}\n');
    return;
  }
  if (request.method !== "POST" || request.url !== "/v1/logs") {
    response.writeHead(404).end();
    return;
  }
  if (!authorized(request, options.config.token)) {
    drain(request);
    response.writeHead(401).end();
    return;
  }
  if (!String(request.headers["content-type"] ?? "").includes("application/json")) {
    drain(request);
    response.writeHead(415).end();
    return;
  }

  try {
    const body = await readBody(request, options.maximumBytes);
    const payload = JSON.parse(body);
    for (const decision of extractClaudeToolDecisions(payload)) {
      options.onDecision(decision);
    }
    for (const prompt of extractClaudeUserPrompts(payload)) {
      options.onPrompt(prompt);
    }
    for (const event of extractClaudeEventSummaries(payload)) {
      options.onEvent(event);
    }
    response.setHeader("Content-Type", "application/json");
    response.writeHead(200).end("{}\n");
  } catch (error) {
    if (error?.code === "FIRSTTOK_TOO_LARGE") {
      response.writeHead(413).end();
    } else {
      response.writeHead(400).end();
    }
  }
}

function authorized(request, token) {
  const supplied = String(request.headers.authorization ?? "");
  const expected = `Bearer ${token}`;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function readBody(request, maximumBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maximumBytes && !tooLarge) {
        tooLarge = true;
        const error = new Error("OTLP request is too large.");
        error.code = "FIRSTTOK_TOO_LARGE";
        reject(error);
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

function drain(request) {
  request.resume();
}

function querySourceCategory(value) {
  if (!value) return null;
  if (value === "repl_main_thread" || value === "main") return "main";
  if (value === "compact") return "compact";
  return "other";
}

function attributesToObject(attributes) {
  const result = {};
  for (const item of array(attributes)) {
    if (typeof item?.key !== "string") continue;
    result[item.key] = anyValue(item.value);
  }
  return result;
}

function anyValue(value) {
  if (!value || typeof value !== "object") return null;
  for (const key of [
    "stringValue",
    "boolValue",
    "intValue",
    "doubleValue",
    "bytesValue"
  ]) {
    if (key in value) return value[key];
  }
  return null;
}

function eventTimestamp(attributes, record) {
  const explicit = Date.parse(stringValue(attributes["event.timestamp"]) ?? "");
  if (Number.isFinite(explicit)) return explicit;
  try {
    const nanoseconds = BigInt(record?.timeUnixNano ?? 0);
    const milliseconds = Number(nanoseconds / 1_000_000n);
    if (Number.isFinite(milliseconds) && milliseconds > 0) return milliseconds;
  } catch {
    // Fall through to the local receive time.
  }
  return Date.now();
}

function stringValue(value) {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function array(value) {
  return Array.isArray(value) ? value : [];
}
