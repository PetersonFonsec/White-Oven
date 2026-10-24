import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeError,
  sanitizeText,
  stackFrames,
} from "../src/logging/sanitize";

describe("sanitizeText", () => {
  const cases: ReadonlyArray<[string, string, RegExp]> = [
    ["e-mail", "login failed for ana@example.com", /ana@example/],
    ["bearer token", "header Bearer abc.DEF-123", /abc\.DEF/],
    [
      "JWT",
      "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl rejected",
      /eyJ/,
    ],
    ["password assignment", "password=hunter2 rejected", /hunter2/],
    ["quoted secret", 'api_key: "k-123" invalid', /k-123/],
    [
      "connection string credentials",
      "connect postgres://app:s3cret@db:5432/wo failed",
      /app:s3cret/,
    ],
    [
      "SQL literal",
      "SELECT * FROM users WHERE cpf = '123.456.789-09'",
      /123\.456/,
    ],
    [
      "PostgreSQL constraint detail",
      "duplicate key value violates unique constraint. Key (whatsapp)=(+5511999999999) already exists.",
      /5511999999999/,
    ],
    ["phone with separators", "call +55 (11) 99999-9999 now", /99999-9999/],
    ["CPF digits", "cpf 12345678909 invalid", /12345678909/],
    ["query string", "GET /v1/x?email=a&name=Ana failed", /name=Ana/],
  ];

  for (const [label, input, leak] of cases) {
    it(`masks ${label}`, () => {
      assert.doesNotMatch(sanitizeText(input), leak);
    });
  }

  it("keeps operational messages readable", () => {
    for (const text of [
      "Mapped {/health, GET} route",
      "Nest can't resolve dependencies of the HealthController (?)",
      "api listening on port 3000",
      "request completed",
    ]) {
      assert.equal(sanitizeText(text), text);
    }
  });

  it("flattens control characters so one entry cannot forge another line", () => {
    const result = sanitizeText(
      'ok\n{"level":"error","msg":"forged"}\r\x1b[31m',
    );
    // eslint-disable-next-line no-control-regex
    assert.doesNotMatch(result, /[\n\r\x1b]/);
  });

  it("bounds the length of a message", () => {
    assert.ok(sanitizeText("a".repeat(10_000)).length <= 501);
  });
});

describe("stack handling", () => {
  it("keeps only frames, even when the message spans several lines", () => {
    const error = new Error("first line\nsecond ana@example.com\n  third 'x'");
    const frames = stackFrames(error.stack);
    assert.ok(frames.length > 0);
    assert.ok(frames.every((frame) => frame.startsWith("at ")));
    assert.doesNotMatch(JSON.stringify(frames), /first line|ana@example|third/);
  });

  it("describes errors by type and frames, never by message", () => {
    class QueryFailedError extends Error {}
    const described = describeError(
      new QueryFailedError("WHERE email='a@b.co'"),
    );
    assert.equal(described.errorType, "QueryFailedError");
    assert.doesNotMatch(JSON.stringify(described), /a@b\.co|WHERE/);
    assert.deepEqual(describeError("boom"), {
      errorType: "string",
      frames: [],
    });
  });
});
