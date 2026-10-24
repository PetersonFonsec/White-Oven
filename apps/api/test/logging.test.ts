import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JsonLogger, redact } from "../src/logging/json-logger";

describe("JsonLogger", () => {
  it("writes one JSON object per line with level, time and message", () => {
    const lines: string[] = [];
    new JsonLogger("info", (line) => lines.push(line)).write("info", "hello", {
      route: "/health",
    });
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]!);
    assert.equal(entry.level, "info");
    assert.equal(entry.msg, "hello");
    assert.equal(entry.route, "/health");
    assert.ok(!Number.isNaN(Date.parse(entry.time)));
  });

  it("drops entries below the configured level", () => {
    const lines: string[] = [];
    const logger = new JsonLogger("warn", (line) => lines.push(line));
    logger.write("debug", "d");
    logger.write("info", "i");
    logger.write("warn", "w");
    logger.write("error", "e");
    assert.deepEqual(
      lines.map((line) => JSON.parse(line).msg),
      ["w", "e"],
    );
  });

  it("adapts Nest's LoggerService calls and keeps the context", () => {
    const lines: string[] = [];
    const logger = new JsonLogger("debug", (line) => lines.push(line));
    logger.log("started", "NestApplication");
    logger.error("boom", "stack trace", "ExceptionsHandler");
    const info = JSON.parse(lines[0]!);
    assert.equal(info.level, "info");
    assert.equal(info.context, "NestApplication");
    const error = JSON.parse(lines[1]!);
    assert.equal(error.context, "ExceptionsHandler");
    assert.equal(error.stack, undefined);
  });
});

describe("redact", () => {
  it("masks personal data and secrets at any depth", () => {
    const value = redact({
      route: "/v1/x",
      email: "a@b.c",
      whatsapp: "+5511999999999",
      nested: {
        password: "x",
        Authorization: "Bearer y",
        list: [{ refreshToken: "z", cpf: "1" }],
      },
      name: "Ana",
      requestId: "abc",
    });
    assert.deepEqual(value, {
      route: "/v1/x",
      email: "[REDACTED]",
      whatsapp: "[REDACTED]",
      nested: {
        password: "[REDACTED]",
        Authorization: "[REDACTED]",
        list: [{ refreshToken: "[REDACTED]", cpf: "[REDACTED]" }],
      },
      name: "[REDACTED]",
      requestId: "abc",
    });
  });
});
