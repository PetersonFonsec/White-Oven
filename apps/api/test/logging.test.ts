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
    const info = JSON.parse(lines[0]!);
    assert.equal(info.level, "info");
    assert.equal(info.msg, "started");
    assert.equal(info.context, "NestApplication");
  });
});

describe("JsonLogger security", () => {
  const capture = () => {
    const lines: string[] = [];
    const logger = new JsonLogger("debug", (line) => lines.push(line));
    return { logger, entries: () => lines.map((line) => JSON.parse(line)) };
  };

  it("sanitizes the free-text msg passed to write()", () => {
    const { logger, entries } = capture();
    logger.write("warn", "login failed for ana@example.com, Bearer abc.def");
    const [entry] = entries();
    assert.doesNotMatch(entry.msg, /ana@example|abc\.def/);
    assert.match(entry.msg, /^login failed for \[EMAIL\]/);
  });

  it("sanitizes string field values under non-sensitive keys", () => {
    const { logger, entries } = capture();
    logger.write("info", "event", {
      detail: "token=xyz from +55 11 99999-9999",
      nested: { reason: "WHERE email='ana@example.com'" },
    });
    assert.doesNotMatch(JSON.stringify(entries()), /xyz|99999|ana@example/);
  });

  it("does not let fields overwrite time, level or msg", () => {
    const { logger, entries } = capture();
    logger.write("info", "real", { level: "error", msg: "forged", time: "x" });
    const [entry] = entries();
    assert.equal(entry.level, "info");
    assert.equal(entry.msg, "real");
    assert.notEqual(entry.time, "x");
  });

  it("keeps the API-generated requestId verbatim", () => {
    const { logger, entries } = capture();
    logger.write("info", "event", {
      requestId: "12345678-1234-1234-1234-123456789012",
    });
    assert.equal(
      entries()[0].requestId,
      "12345678-1234-1234-1234-123456789012",
    );
  });

  it("keeps the tenantId resolved by the API verbatim, even when it ends in digits", () => {
    const { logger, entries } = capture();
    logger.write("info", "event", {
      tenantId: "ce660541-9772-4dfd-96ce-428610097648",
    });
    assert.equal(entries()[0].tenantId, "ce660541-9772-4dfd-96ce-428610097648");
  });

  it("logs an Error passed as message by type and frames, without its text", () => {
    const { logger, entries } = capture();
    logger.log(
      new Error("SELECT * FROM u WHERE email='ana@example.com'"),
      "Ctx",
    );
    const [entry] = entries();
    assert.equal(entry.errorType, "Error");
    assert.equal(entry.context, "Ctx");
    assert.ok(entry.frames.length > 0);
    assert.doesNotMatch(JSON.stringify(entry), /SELECT|ana@example/);
  });

  it("handles Nest's error(message, stack, context) without leaking either", () => {
    const { logger, entries } = capture();
    const error = new Error("multi\nline ana@example.com");
    logger.error(
      "Key (email)=(ana@example.com) already exists",
      error.stack,
      "ExceptionsHandler",
    );
    const [entry] = entries();
    assert.equal(entry.level, "error");
    assert.equal(entry.context, "ExceptionsHandler");
    assert.ok(entry.frames.every((frame: string) => frame.startsWith("at ")));
    assert.doesNotMatch(JSON.stringify(entry), /ana@example|multi|line /);
  });

  it("redacts objects passed as message by libraries", () => {
    const { logger, entries } = capture();
    logger.warn({ query: "x", email: "ana@example.com", note: "pwd: 123" });
    const [entry] = entries();
    assert.equal(entry.msg, "structured log");
    assert.equal(entry.data.email, "[REDACTED]");
    assert.doesNotMatch(JSON.stringify(entry), /ana@example|pwd: 123/);
  });

  for (const method of [
    "log",
    "warn",
    "debug",
    "verbose",
    "fatal",
    "error",
  ] as const) {
    it(`sanitizes string messages on ${method}()`, () => {
      const { logger, entries } = capture();
      logger[method]("connect postgres://app:s3cret@db/wo failed");
      assert.doesNotMatch(JSON.stringify(entries()), /s3cret/);
    });
  }
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
      error: new Error("ana@example.com"),
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
      error: (value as { error: unknown }).error,
    });
    assert.doesNotMatch(JSON.stringify(value), /ana@example/);
  });
});
