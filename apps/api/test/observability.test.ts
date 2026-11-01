import assert from "node:assert/strict";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { Controller, Get, Module } from "@nestjs/common";
import { PublicRoute } from "../src/auth/route-access";
import { ConfigError, loadConfig } from "../src/config/config";
import {
  ApiMetrics,
  LATENCY_BUCKETS_SECONDS,
  NO_TENANT,
  OVERFLOW,
} from "../src/observability/metrics";
import {
  UNREACHABLE_DATABASE_URL,
  json,
  metricValue,
  nextTick,
  startTestServer,
  type TestServer,
} from "./helpers";

const TOKEN = "metrics-token-0123456789-abcdefghijklmnop";
const TENANT = "0b6f1c1e-6d1a-4c3b-9a55-1f2e3d4c5b6a";

@PublicRoute()
@Controller("observability-probe")
class ObservabilityProbeController {
  @Get("crash")
  crash(): never {
    throw new Error("failed for ana@example.com");
  }
}

@Module({ controllers: [ObservabilityProbeController] })
class ObservabilityProbeModule {}

describe("ApiMetrics", () => {
  it("renders counters and a cumulative histogram in the Prometheus text format", () => {
    const metrics = new ApiMetrics(() => 1_700_000_000_500);
    metrics.observeRequest({
      tenantId: TENANT,
      method: "POST",
      route: "/v1/customer/stores/:slug/me/orders",
      statusCode: 201,
      durationSeconds: 0.07,
    });
    metrics.observeRequest({
      tenantId: TENANT,
      method: "POST",
      route: "/v1/customer/stores/:slug/me/orders",
      statusCode: 500,
      durationSeconds: 3,
    });
    metrics.orderCreated(TENANT);
    metrics.orderTransition(TENANT, "PREPARING", "STAFF");
    metrics.unhandledError(undefined);
    metrics.jobFailed("push_delivery");
    const text = metrics.render();
    const route = "/v1/customer/stores/:slug/me/orders";

    assert.match(text, /# TYPE whiteoven_http_requests_total counter/);
    assert.match(
      text,
      /# TYPE whiteoven_http_request_duration_seconds histogram/,
    );
    for (const status of ["201", "500"])
      assert.equal(
        metricValue(text, "whiteoven_http_requests_total", {
          tenant: TENANT,
          route,
          method: "POST",
          status,
        }),
        1,
      );
    const bucket = (le: string) =>
      metricValue(text, "whiteoven_http_request_duration_seconds_bucket", {
        tenant: TENANT,
        route,
        method: "POST",
        le,
      });
    assert.equal(bucket("0.05"), 0);
    assert.equal(bucket("0.1"), 1);
    assert.equal(bucket("2.5"), 1);
    assert.equal(bucket("5"), 2);
    assert.equal(bucket("+Inf"), 2);
    assert.equal(
      metricValue(text, "whiteoven_http_request_duration_seconds_count", {
        tenant: TENANT,
        route,
        method: "POST",
      }),
      2,
    );
    assert.equal(
      metricValue(text, "whiteoven_orders_created_total", { tenant: TENANT }),
      1,
    );
    assert.equal(
      metricValue(text, "whiteoven_order_transitions_total", {
        tenant: TENANT,
        to: "PREPARING",
        actor: "STAFF",
      }),
      1,
    );
    assert.equal(
      metricValue(text, "whiteoven_unhandled_errors_total", {
        tenant: NO_TENANT,
      }),
      1,
    );
    assert.equal(
      metricValue(text, "whiteoven_background_job_failures_total", {
        job: "push_delivery",
      }),
      1,
    );
    assert.equal(
      metricValue(text, "process_start_time_seconds"),
      1_700_000_000,
    );
    assert.equal(
      LATENCY_BUCKETS_SECONDS.length + 1,
      text.split("\n").filter((line) => line.includes("_bucket{")).length,
    );
  });

  it("only takes label values the API decided: route templates, UUID tenants, known methods", () => {
    const metrics = new ApiMetrics();
    metrics.observeRequest({
      tenantId: "ana@example.com",
      method: "BREW",
      route: "/v1/stores/ana@example.com?phone=11999999999",
      statusCode: 200,
      durationSeconds: 0.01,
    });
    metrics.observeRequest({
      method: "GET",
      route: undefined,
      statusCode: 404,
      durationSeconds: 0.01,
    });
    const text = metrics.render();
    assert.doesNotMatch(text, /ana|example|1199|BREW/);
    assert.equal(
      metricValue(text, "whiteoven_http_requests_total", {
        tenant: NO_TENANT,
        route: "<unmatched>",
        method: "OTHER",
        status: "200",
      }),
      1,
    );
    assert.equal(
      metricValue(text, "whiteoven_http_requests_total", {
        tenant: NO_TENANT,
        route: "<unmatched>",
        method: "GET",
        status: "404",
      }),
      1,
    );
  });

  it("never evicts a live series: past the ceiling new label sets fold into one overflow series", () => {
    const metrics = new ApiMetrics(Date.now, 3);
    const tenants = Array.from(
      { length: 10 },
      (_, index) =>
        `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    for (const tenant of tenants) metrics.orderCreated(tenant);
    metrics.orderCreated(tenants[0]!);
    const text = metrics.render();
    assert.equal(
      metricValue(text, "whiteoven_orders_created_total", {
        tenant: tenants[0]!,
      }),
      2,
    );
    assert.equal(
      metricValue(text, "whiteoven_orders_created_total", {
        tenant: tenants[2]!,
      }),
      1,
    );
    assert.equal(
      metricValue(text, "whiteoven_orders_created_total", { tenant: OVERFLOW }),
      7,
    );
    assert.equal(
      metricValue(text, "whiteoven_metrics_series_dropped_total", {
        metric: "whiteoven_orders_created_total",
      }),
      7,
    );
    assert.equal(
      text
        .split("\n")
        .filter((line) => line.startsWith("whiteoven_orders_created_total{"))
        .length,
      4,
    );
  });
});

describe("API_METRICS_TOKEN", () => {
  const base = { DATABASE_URL: UNREACHABLE_DATABASE_URL };
  it("is optional and refused when short or with unexpected characters", () => {
    assert.equal(loadConfig(base).metricsToken, null);
    assert.equal(
      loadConfig({ ...base, API_METRICS_TOKEN: TOKEN }).metricsToken,
      TOKEN,
    );
    for (const bad of ["short", `${TOKEN} space`, `${TOKEN}\n`])
      assert.throws(
        () => loadConfig({ ...base, API_METRICS_TOKEN: bad }),
        (error: unknown) =>
          error instanceof ConfigError &&
          !error.message.includes(bad) &&
          /API_METRICS_TOKEN/.test(error.message),
      );
  });
});

describe("GET /metrics", () => {
  let server: TestServer;
  let closed: TestServer;
  const metrics = new ApiMetrics();
  const scrape = (token = TOKEN) =>
    fetch(`${server.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${token}` },
    });

  before(async () => {
    server = await startTestServer(
      { API_METRICS_TOKEN: TOKEN },
      { imports: [ObservabilityProbeModule], metrics },
    );
    closed = await startTestServer();
  });
  after(async () => {
    await server.close();
    await closed.close();
  });

  it("is a plain 404 when no token is configured", async () => {
    const response = await fetch(`${closed.baseUrl}/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(response.status, 404);
    assert.equal((await json(response)).code, "NOT_FOUND");
    assert.equal(
      (await fetch(`${closed.baseUrl}/v1/metrics`)).status,
      404,
      "not under /v1 either",
    );
  });

  it("asks for the bearer token and answers it with Prometheus text, uncached", async () => {
    assert.equal((await fetch(`${server.baseUrl}/metrics`)).status, 401);
    assert.equal((await scrape(`${TOKEN}x`)).status, 401);
    const wrongScheme = await fetch(`${server.baseUrl}/metrics`, {
      headers: { authorization: `Basic ${TOKEN}` },
    });
    assert.equal(wrongScheme.status, 401);
    const response = await scrape();
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") ?? "",
      /^text\/plain;.*version=0\.0\.4/,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(await response.text(), /process_start_time_seconds \d+/);
  });

  it("counts status, latency and unhandled errors without PII, and leaves its own route out", async () => {
    const before = metrics.render();
    await fetch(
      `${server.baseUrl}/health?email=ana@example.com&phone=11999999999`,
      { headers: { "user-agent": "secret-agent" } },
    );
    await fetch(`${server.baseUrl}/health/ready`);
    await fetch(`${server.baseUrl}/v1/observability-probe/crash`);
    await fetch(`${server.baseUrl}/v1/public/stores/ana@example.com/nothing`);
    await scrape();
    await scrape("wrong-token-wrong-token-wrong-token");
    await nextTick();
    const text = await (await scrape()).text();
    const delta = (name: string, labels: Record<string, string>) =>
      metricValue(text, name, labels) - metricValue(before, name, labels);

    const requests = "whiteoven_http_requests_total";
    const none = { tenant: NO_TENANT, method: "GET" };
    assert.equal(
      delta(requests, { ...none, route: "/health", status: "200" }),
      1,
    );
    assert.equal(
      delta(requests, { ...none, route: "/health/ready", status: "503" }),
      1,
    );
    assert.equal(
      delta(requests, {
        ...none,
        route: "/v1/observability-probe/crash",
        status: "500",
      }),
      1,
    );
    assert.equal(
      delta(requests, { ...none, route: "<unmatched>", status: "404" }),
      1,
    );
    assert.equal(
      delta("whiteoven_unhandled_errors_total", { tenant: NO_TENANT }),
      1,
    );
    assert.equal(
      delta("whiteoven_http_request_duration_seconds_count", {
        ...none,
        route: "/health/ready",
      }),
      1,
    );
    assert.doesNotMatch(text, /route="\/metrics"/);
    assert.doesNotMatch(text, /ana|example|1199|secret-agent|wrong-token/);

    // The access log carries the same fields and nothing more.
    assert.doesNotMatch(
      JSON.stringify(server.logs),
      /ana@example|11999999999|secret-agent|wrong-token|metrics-token/,
    );
  });
});

describe("monitor contract", () => {
  it("ops/api-monitor.mjs reads what the API renders", async () => {
    // Native import() from this CommonJS build: the monitor is an ES module without types.
    const load = new Function("path", "return import(path)") as (
      path: string,
    ) => Promise<{
      parseMetrics(text: string): unknown;
      summarize(series: unknown): {
        startTime: number;
        groups: Record<string, { requests: number; errors: number }>;
        jobs: Record<string, number>;
      };
      p95Bound(buckets: unknown): number | null;
    }>;
    const monitor = await load(
      pathToFileURL(resolve(__dirname, "../../../../../ops/api-monitor.mjs"))
        .href,
    );
    const metrics = new ApiMetrics(() => 1_700_000_000_000);
    for (let index = 0; index < 20; index++)
      metrics.observeRequest({
        tenantId: TENANT,
        method: "GET",
        route: "/v1/public/stores/:slug/menu",
        statusCode: index < 3 ? 503 : 200,
        durationSeconds: index === 0 ? 4 : 0.02,
      });
    metrics.jobFailed("order_accept_timeout");
    const summary = monitor.summarize(monitor.parseMetrics(metrics.render()));
    assert.equal(summary.startTime, 1_700_000_000);
    assert.equal(summary.groups.all!.requests, 20);
    assert.equal(summary.groups[TENANT]!.errors, 3);
    assert.equal(summary.jobs.order_accept_timeout, 1);
    assert.equal(
      monitor.p95Bound(
        (summary.groups[TENANT] as unknown as { buckets: unknown }).buckets,
      ),
      0.025,
    );
  });
});
