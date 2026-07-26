import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import {
  claudeOtelEnvironment,
  createClaudeOtelConfig
} from "../companion/claude-otel-config.mjs";
import {
  extractClaudeEventSummaries,
  extractClaudeUserPrompts,
  extractClaudeToolDecisions,
  startClaudeOtelReceiver
} from "../companion/claude-otel-receiver.mjs";

test("configures logs-only local telemetry with every content gate disabled", async () => {
  const config = createClaudeOtelConfig(await availablePort());
  const environment = claudeOtelEnvironment(config);

  assert.equal(environment.OTEL_METRICS_EXPORTER, "none");
  assert.equal(environment.OTEL_LOGS_EXPORTER, "otlp");
  assert.equal(environment.OTEL_TRACES_EXPORTER, "none");
  assert.equal(environment.OTEL_EXPORTER_OTLP_LOGS_PROTOCOL, "http/json");
  assert.equal(
    environment.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
    `http://127.0.0.1:${config.port}/v1/logs`
  );
  assert.equal(environment.OTEL_LOG_USER_PROMPTS, "0");
  assert.equal(environment.OTEL_LOG_ASSISTANT_RESPONSES, "0");
  assert.equal(environment.OTEL_LOG_TOOL_DETAILS, "0");
  assert.equal(environment.OTEL_LOG_TOOL_CONTENT, "0");
  assert.equal(environment.OTEL_LOG_RAW_API_BODIES, "0");
});

test("extracts only documented Claude tool-decision fields", () => {
  const payload = decisionPayload({
    sessionId: "session-native",
    source: "user_temporary",
    decision: "accept",
    privatePrompt: "do not retain this",
    privateCommand: "private command"
  });
  const decisions = extractClaudeToolDecisions(payload);

  assert.deepEqual(decisions, [
    {
      sessionId: "session-native",
      decision: "accept",
      source: "user_temporary",
      toolUseId: "toolu_123",
      sequence: "7",
      promptId: "prompt-diagnostic",
      serviceName: "claude-code",
      terminalType: "iTerm.app",
      timestamp: Date.parse("2026-07-24T20:00:00.000Z")
    }
  ]);
  assert.equal(JSON.stringify(decisions).includes("do not retain"), false);
  assert.equal(JSON.stringify(decisions).includes("private command"), false);
  assert.equal(JSON.stringify(decisions).includes("user@example.com"), false);
});

test("extracts a content-free user prompt lifecycle signal", () => {
  const payload = userPromptPayload({
    sessionId: "session-follow-up",
    privatePrompt: "do this instead"
  });
  const prompts = extractClaudeUserPrompts(payload);

  assert.deepEqual(prompts, [
    {
      sessionId: "session-follow-up",
      sequence: "8",
      serviceName: "claude-code",
      terminalType: "iTerm.app",
      timestamp: Date.parse("2026-07-24T20:00:01.000Z")
    }
  ]);
  assert.equal(JSON.stringify(prompts).includes("do this instead"), false);
  assert.equal(JSON.stringify(prompts).includes("user@example.com"), false);
});

test("extracts only content-free event ordering for diagnostics", () => {
  const payload = decisionPayload({
    sessionId: "session-diagnostic",
    source: "user_reject",
    decision: "reject",
    privatePrompt: "do this other private thing",
    privateCommand: "private command"
  });

  assert.deepEqual(extractClaudeEventSummaries(payload), [
    {
      eventName: "tool_decision",
      sessionId: "session-diagnostic",
      sequence: "7",
      promptId: "prompt-diagnostic",
      querySource: null,
      timestamp: Date.parse("2026-07-24T20:00:00.000Z")
    }
  ]);
  const serialized = JSON.stringify(extractClaudeEventSummaries(payload));
  assert.equal(serialized.includes("do this other private thing"), false);
  assert.equal(serialized.includes("private command"), false);
  assert.equal(serialized.includes("user@example.com"), false);
});

test("classifies main-thread API requests without retaining request content", () => {
  const events = extractClaudeEventSummaries(
    apiRequestPayload({
      sessionId: "session-replacement",
      privateRequest: "never retain this request"
    })
  );

  assert.deepEqual(events, [
    {
      eventName: "api_request",
      sessionId: "session-replacement",
      sequence: "9",
      promptId: "prompt-replacement",
      querySource: "main",
      timestamp: Date.parse("2026-07-24T20:00:02.000Z")
    }
  ]);
  assert.equal(JSON.stringify(events).includes("never retain"), false);
});

test("ignores non-decision, malformed, and non-user decision records", () => {
  const payload = decisionPayload({
    sessionId: "ignored",
    source: "unknown-source",
    decision: "accept"
  });
  payload.resourceLogs[0].scopeLogs[0].logRecords.push({
    attributes: [
      attribute("event.name", "tool_result"),
      attribute("session.id", "ignored")
    ]
  });
  assert.deepEqual(extractClaudeToolDecisions(payload), []);

  assert.deepEqual(
    extractClaudeToolDecisions(
      decisionPayload({
        sessionId: "automatic",
        source: "config",
        decision: "accept"
      })
    ),
    []
  );

  assert.deepEqual(
    extractClaudeToolDecisions(
      decisionPayload({
        sessionId: "hook-policy",
        source: "hook",
        decision: "reject"
      })
    ),
    []
  );
});

test("accepts authenticated OTLP JSON, rejects outsiders, and deduplicates retries", async (t) => {
  const config = createClaudeOtelConfig(await availablePort());
  const decisions = [];
  const prompts = [];
  const events = [];
  const receiver = await startClaudeOtelReceiver({
    config,
    maximumBytes: 32_000,
    onDecision: (decision) => decisions.push(decision),
    onPrompt: (prompt) => prompts.push(prompt),
    onEvent: (event) => events.push(event)
  });
  t.after(() => receiver.close());

  const unauthorized = await fetch(`${receiver.address}/v1/logs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(decisionPayload({ sessionId: "outsider" }))
  });
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(decisions, []);

  const payload = decisionPayload({ sessionId: "session-http" });
  const first = await sendPayload(receiver.address, config.token, payload);
  const retry = await sendPayload(receiver.address, config.token, payload);
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(decisions.length, 1);
  assert.equal(events.length, 1);
  assert.equal(decisions[0].sessionId, "session-http");

  const promptPayload = userPromptPayload({ sessionId: "prompt-http" });
  const promptFirst = await sendPayload(
    receiver.address,
    config.token,
    promptPayload
  );
  const promptRetry = await sendPayload(
    receiver.address,
    config.token,
    promptPayload
  );
  assert.equal(promptFirst.status, 200);
  assert.equal(promptRetry.status, 200);
  assert.equal(prompts.length, 1);
  assert.equal(events.length, 2);
  assert.equal(prompts[0].sessionId, "prompt-http");

  const health = await fetch(`${receiver.address}/health`, {
    headers: { Authorization: `Bearer ${config.token}` }
  });
  assert.equal(health.status, 200);
});

test("bounds request bodies and rejects invalid JSON without leaking data", async (t) => {
  const config = createClaudeOtelConfig(await availablePort());
  const decisions = [];
  const receiver = await startClaudeOtelReceiver({
    config,
    maximumBytes: 100,
    onDecision: (decision) => decisions.push(decision)
  });
  t.after(() => receiver.close());

  const tooLarge = await fetch(`${receiver.address}/v1/logs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ private: "x".repeat(500) })
  });
  assert.equal(tooLarge.status, 413);

  const invalid = await fetch(`${receiver.address}/v1/logs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json"
    },
    body: "{"
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(decisions, []);
});

function decisionPayload({
  sessionId = "session",
  source = "user_temporary",
  decision = "accept",
  privatePrompt = "<REDACTED>",
  privateCommand = undefined
} = {}) {
  const recordAttributes = [
    attribute("event.name", "tool_decision"),
    attribute("event.timestamp", "2026-07-24T20:00:00.000Z"),
    attribute("event.sequence", "7"),
    attribute("session.id", sessionId),
    attribute("prompt.id", "prompt-diagnostic"),
    attribute("tool_name", "Bash"),
    attribute("tool_use_id", "toolu_123"),
    attribute("decision", decision),
    attribute("source", source),
    attribute("prompt", privatePrompt)
  ];
  if (privateCommand) {
    recordAttributes.push(
      attribute("tool_parameters", JSON.stringify({ full_command: privateCommand }))
    );
  }
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attribute("service.name", "claude-code"),
            attribute("terminal.type", "iTerm.app"),
            attribute("user.email", "user@example.com")
          ]
        },
        scopeLogs: [{ logRecords: [{ attributes: recordAttributes }] }]
      }
    ]
  };
}

function userPromptPayload({
  sessionId = "session",
  privatePrompt = "<REDACTED>"
} = {}) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            attribute("service.name", "claude-code"),
            attribute("terminal.type", "iTerm.app"),
            attribute("user.email", "user@example.com")
          ]
        },
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  attribute("event.name", "user_prompt"),
                  attribute(
                    "event.timestamp",
                    "2026-07-24T20:00:01.000Z"
                  ),
                  attribute("event.sequence", "8"),
                  attribute("session.id", sessionId),
                  attribute("prompt", privatePrompt),
                  attribute("prompt_length", String(privatePrompt.length))
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

function apiRequestPayload({
  sessionId = "session",
  privateRequest = "<REDACTED>"
} = {}) {
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [attribute("service.name", "claude-code")]
        },
        scopeLogs: [
          {
            logRecords: [
              {
                attributes: [
                  attribute("event.name", "api_request"),
                  attribute(
                    "event.timestamp",
                    "2026-07-24T20:00:02.000Z"
                  ),
                  attribute("event.sequence", "9"),
                  attribute("session.id", sessionId),
                  attribute("prompt.id", "prompt-replacement"),
                  attribute("query_source", "repl_main_thread"),
                  attribute("request_body", privateRequest)
                ]
              }
            ]
          }
        ]
      }
    ]
  };
}

function attribute(key, value) {
  return { key, value: { stringValue: value } };
}

async function sendPayload(address, token, payload) {
  return await fetch(`${address}/v1/logs`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
}

async function availablePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" ? address?.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (Number.isInteger(port)) resolve(port);
        else reject(new Error("No test port was allocated."));
      });
    });
  });
}
