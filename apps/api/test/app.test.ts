import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { Controller, Get, HttpStatus, Logger, Module } from "@nestjs/common";
import { PublicRoute } from "../src/auth/route-access";
import { ApiError } from "../src/errors/api-error";
import { json, nextTick, startTestServer, type TestServer } from "./helpers";

@PublicRoute()
@Controller("probe")
class ProbeController {
  @Get("crash")
  crash(): never {
    throw new Error("SELECT * FROM users WHERE email = 'ana@example.com'");
  }

  @Get("crash-multiline")
  crashMultiline(): never {
    throw new Error(
      "query failed\nWHERE email = 'ana@example.com'\n  password=hunter2",
    );
  }

  @Get("library-log")
  libraryLog(): { ok: true } {
    // Code and libraries log through Nest's Logger, which forwards to JsonLogger.
    const logger = new Logger("PaymentsClient");
    logger.warn("retrying for ana@example.com with Bearer abc.def");
    logger.error(new Error("card 4111 1111 1111 1111 declined"));
    return { ok: true };
  }

  @Get("conflict")
  conflict(): never {
    throw new ApiError(
      HttpStatus.CONFLICT,
      "STATE_CONFLICT",
      "Order changed.",
      { expected: "PLACED" },
    );
  }
}

/** Deliberately without an access declaration: the global guard must refuse it. */
@Controller("undeclared-probe")
class UndeclaredProbeController {
  @Get()
  open() {
    return { leaked: true };
  }
}

@Module({ controllers: [ProbeController, UndeclaredProbeController] })
class ProbeModule {}

describe("API application", () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({}, { imports: [ProbeModule] });
  });
  after(() => server.close());

  it("refuses a route without an access declaration and logs it", async () => {
    const response = await fetch(`${server.baseUrl}/v1/undeclared-probe`);
    assert.equal(response.status, 403);
    assert.equal((await json(response)).code, "FORBIDDEN");
    await nextTick();
    assert.ok(
      server.logs.some(
        (log) =>
          log.msg === "route without access declaration" &&
          log.handler === "UndeclaredProbeController.open",
      ),
    );
  });

  it("GET /health answers ok without caching or version details", async () => {
    const response = await fetch(`${server.baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await json(response), { status: "ok" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-powered-by"), null);
  });

  it("GET /health/ready answers 503 with the standard body when the database is unreachable", async () => {
    const response = await fetch(`${server.baseUrl}/health/ready`);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = await json(response);
    assert.deepEqual(Object.keys(body).sort(), [
      "code",
      "message",
      "requestId",
    ]);
    assert.equal(body.code, "NOT_READY");
    assert.equal(body.message, "Service not ready.");
  });

  it("assigns a request id and reuses a well-formed upstream one", async () => {
    const generated = await fetch(`${server.baseUrl}/health`);
    assert.match(
      generated.headers.get("x-request-id") ?? "",
      /^[0-9a-f-]{36}$/,
    );

    const reused = await fetch(`${server.baseUrl}/health`, {
      headers: { "x-request-id": "edge-1234567" },
    });
    assert.equal(reused.headers.get("x-request-id"), "edge-1234567");

    const rejected = await fetch(`${server.baseUrl}/health`, {
      headers: { "x-request-id": "bad id\twith spaces" },
    });
    assert.notEqual(
      rejected.headers.get("x-request-id"),
      "bad id\twith spaces",
    );
  });

  it("returns the standard error body for unknown routes without echoing the path", async () => {
    const response = await fetch(
      `${server.baseUrl}/v1/nope?email=ana@example.com`,
    );
    assert.equal(response.status, 404);
    const body = await json(response);
    assert.deepEqual(Object.keys(body).sort(), [
      "code",
      "message",
      "requestId",
    ]);
    assert.equal(body.code, "NOT_FOUND");
    assert.equal(body.requestId, response.headers.get("x-request-id"));
    assert.doesNotMatch(JSON.stringify(body), /nope|ana@example/);
  });

  it("keeps the code and details of ApiError", async () => {
    const response = await fetch(`${server.baseUrl}/v1/probe/conflict`);
    assert.equal(response.status, 409);
    const body = await json(response);
    assert.equal(body.code, "STATE_CONFLICT");
    assert.equal(body.message, "Order changed.");
    assert.deepEqual(body.details, { expected: "PLACED" });
  });

  it("hides unexpected errors behind a generic 500 and logs no message or PII", async () => {
    const response = await fetch(`${server.baseUrl}/v1/probe/crash`);
    assert.equal(response.status, 500);
    const body = await json(response);
    assert.equal(body.code, "INTERNAL_ERROR");
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /SELECT|ana@example|at |stack/);

    await nextTick();
    const logged = JSON.stringify(server.logs);
    assert.doesNotMatch(logged, /ana@example|SELECT/);
    const entry = server.logs.find((log) => log.msg === "unhandled exception");
    assert.equal(entry?.requestId, body.requestId);
    assert.equal(entry?.errorType, "Error");
  });

  it("never leaks continuation lines of a multi-line error message", async () => {
    server.logs.length = 0;
    const response = await fetch(`${server.baseUrl}/v1/probe/crash-multiline`);
    assert.equal(response.status, 500);
    await nextTick();
    const entry = server.logs.find((log) => log.msg === "unhandled exception");
    assert.ok(Array.isArray(entry?.frames));
    assert.ok(
      (entry.frames as string[]).every((frame) => frame.startsWith("at ")),
    );
    assert.doesNotMatch(
      JSON.stringify(server.logs),
      /ana@example|hunter2|WHERE/,
    );
  });

  it("sanitizes messages logged through Nest's Logger by code and libraries", async () => {
    server.logs.length = 0;
    const response = await fetch(`${server.baseUrl}/v1/probe/library-log`);
    assert.equal(response.status, 200);
    await nextTick();
    const warn = server.logs.find(
      (log) => log.context === "PaymentsClient" && log.level === "warn",
    );
    assert.match(String(warn?.msg), /^retrying for \[EMAIL\]/);
    const error = server.logs.find(
      (log) => log.context === "PaymentsClient" && log.level === "error",
    );
    assert.equal(error?.errorType, "Error");
    assert.doesNotMatch(
      JSON.stringify(server.logs),
      /ana@example|abc\.def|4111/,
    );
  });

  it("writes structured access logs with the route template only", async () => {
    server.logs.length = 0;
    await fetch(`${server.baseUrl}/health?phone=11999999999`, {
      headers: { "user-agent": "secret-agent", authorization: "Bearer abc" },
    });
    await fetch(`${server.baseUrl}/v1/does-not-exist/ana@example.com`);
    await nextTick();
    const access = server.logs.filter((log) => log.msg === "request completed");
    assert.equal(access.length, 2);
    assert.deepEqual(
      access.map(({ method, route, statusCode }) => ({
        method,
        route,
        statusCode,
      })),
      [
        { method: "GET", route: "/health", statusCode: 200 },
        { method: "GET", route: "<unmatched>", statusCode: 404 },
      ],
    );
    assert.equal(typeof access[0]!.durationMs, "number");
    assert.doesNotMatch(
      JSON.stringify(server.logs),
      /11999999999|secret-agent|Bearer|ana@example/,
    );
  });

  it("rejects malformed JSON with the standard body", async () => {
    const response = await fetch(`${server.baseUrl}/v1/probe/conflict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.code, "BAD_REQUEST");
  });
});

describe("OpenAPI", () => {
  it("publishes the document with health and the error schema when enabled", async () => {
    const server = await startTestServer({ API_OPENAPI_ENABLED: "true" });
    try {
      const response = await fetch(`${server.baseUrl}/v1/openapi.json`);
      assert.equal(response.status, 200);
      const document = await json(response);
      assert.match(document.openapi, /^3\./);
      assert.ok(document.paths["/health"]?.get);
      assert.ok(document.paths["/health/ready"]?.get);
      assert.ok(document.components.schemas.ApiErrorBody);
      assert.ok(document.components.schemas.HealthBody);
    } finally {
      await server.close();
    }
  });

  it("is not served when disabled", async () => {
    const server = await startTestServer({ API_OPENAPI_ENABLED: "false" });
    try {
      const response = await fetch(`${server.baseUrl}/v1/openapi.json`);
      assert.equal(response.status, 404);
    } finally {
      await server.close();
    }
  });
});
