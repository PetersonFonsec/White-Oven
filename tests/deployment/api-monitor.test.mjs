// The API monitor's alert decisions (M7.4, ADR 0032) against a fake API and a fake webhook on
// loopback: availability, error rate and latency per store, job failures, repeats, recovery,
// a webhook that fails, restarts, and the command line. Synthetic data only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  MonitorConfigError,
  emptyState,
  evaluate,
  loadMonitorConfig,
  p95Bound,
  parseMetrics,
  runCheck,
  sendTestAlert,
  summarize,
} from "../../ops/api-monitor.mjs";

const root = resolve(import.meta.dirname, "../..");
const TOKEN = "monitor-token-0123456789-abcdefghijklmnop";
const STORE_A = "0b6f1c1e-6d1a-4c3b-9a55-1f2e3d4c5b6a";
const STORE_B = "7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f";
const BUCKETS = [
  "0.025",
  "0.05",
  "0.1",
  "0.25",
  "0.5",
  "1",
  "2.5",
  "5",
  "10",
  "+Inf",
];
const MINUTE = 60_000;

/**
 * Prometheus text as the API renders it. Per store: `ok` 200s and `errors` 500s on the order
 * route, `slow` of all requests took 3 s and the rest 0.04 s.
 */
function metricsText({ start = 1_700_000_000, stores = {}, jobs = {} } = {}) {
  const route = "/v1/customer/stores/:slug/me/orders";
  const lines = [
    "# HELP whiteoven_http_requests_total HTTP requests.",
    "# TYPE whiteoven_http_requests_total counter",
  ];
  for (const [tenant, { ok = 0, errors = 0 }] of Object.entries(stores)) {
    lines.push(
      `whiteoven_http_requests_total{tenant="${tenant}",route="${route}",method="POST",status="201"} ${ok}`,
      `whiteoven_http_requests_total{tenant="${tenant}",route="${route}",method="POST",status="500"} ${errors}`,
    );
  }
  lines.push("# TYPE whiteoven_http_request_duration_seconds histogram");
  for (const [tenant, { ok = 0, errors = 0, slow = 0 }] of Object.entries(
    stores,
  )) {
    const total = ok + errors;
    for (const le of BUCKETS) {
      const bound = le === "+Inf" ? Infinity : Number(le);
      const count =
        (bound >= 0.04 ? total - slow : 0) + (bound >= 3 ? slow : 0);
      lines.push(
        `whiteoven_http_request_duration_seconds_bucket{tenant="${tenant}",route="${route}",method="POST",le="${le}"} ${count}`,
      );
    }
    lines.push(
      `whiteoven_http_request_duration_seconds_count{tenant="${tenant}",route="${route}",method="POST"} ${total}`,
    );
  }
  for (const [job, value] of Object.entries(jobs))
    lines.push(
      `whiteoven_background_job_failures_total{job="${job}"} ${value}`,
    );
  lines.push(`process_start_time_seconds ${start}`);
  return `${lines.join("\n")}\n`;
}

async function listen(handler) {
  const server = createServer(handler);
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** A fake API and a fake webhook; every knob is mutable between checks. */
async function harness(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "whiteoven-monitor-"));
  const api = {
    ready: 200,
    metrics: metricsText(),
    metricsStatus: 200,
    auth: [],
  };
  const hook = { status: 200, posts: [] };
  const apiServer = await listen((req, res) => {
    if (req.url === "/health/ready") {
      res.writeHead(api.ready, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          api.ready === 200 ? { status: "ok" } : { code: "NOT_READY" },
        ),
      );
    } else if (req.url === "/metrics") {
      api.auth.push(req.headers.authorization);
      const authorized = req.headers.authorization === `Bearer ${TOKEN}`;
      res.writeHead(authorized ? api.metricsStatus : 401, {
        "content-type": "text/plain",
      });
      res.end(authorized ? api.metrics : "");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const hookServer = await listen((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      hook.posts.push(JSON.parse(body));
      res.writeHead(hook.status);
      res.end();
    });
  });
  const env = {
    MONITOR_API_URL: apiServer.url,
    MONITOR_METRICS_TOKEN: TOKEN,
    MONITOR_WEBHOOK_URL: `${hookServer.url}/hook?key=secret-hook-key`,
    MONITOR_STATE_FILE: join(dir, "state.json"),
    MONITOR_ENVIRONMENT: "piloto",
    ...extraEnv,
  };
  const config = loadMonitorConfig(env);
  let clock = Date.UTC(2026, 10, 1, 12, 0);
  const check = async (advance = MINUTE) => {
    clock += advance;
    const before = hook.posts.length;
    const code = await runCheck(config, { now: () => clock });
    return { code, sent: hook.posts.slice(before).map((post) => post.text) };
  };
  const state = () => JSON.parse(readFileSync(env.MONITOR_STATE_FILE, "utf8"));
  const close = async () => {
    await apiServer.close();
    await hookServer.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { api, hook, env, config, check, state, close, now: () => clock };
}

test("configuration names the variables and never echoes their values", () => {
  assert.throws(
    () => loadMonitorConfig({}),
    (error) =>
      error instanceof MonitorConfigError &&
      error.problems.includes("MONITOR_API_URL is required") &&
      error.problems.includes("MONITOR_WEBHOOK_URL is required"),
  );
  const bad = {
    MONITOR_API_URL: "http://user:pass@api.internal:3000",
    MONITOR_WEBHOOK_URL: "http://hooks.example.test/abc-secret",
    MONITOR_METRICS_TOKEN: "short",
    MONITOR_ERROR_RATE: "5",
    MONITOR_WEBHOOK_FORMAT: "teams",
  };
  assert.throws(
    () => loadMonitorConfig(bad),
    (error) =>
      error instanceof MonitorConfigError &&
      error.problems.length === 5 &&
      !/pass|abc-secret|short|teams/.test(
        error.message.replace(/MONITOR_\w+/g, ""),
      ),
  );
  // test-alert needs only the webhook.
  assert.equal(
    loadMonitorConfig(
      { MONITOR_WEBHOOK_URL: "https://hooks.example.test/x" },
      "test-alert",
    ).apiUrl,
    null,
  );
});

test("parses the API's text and finds the p95 bucket", () => {
  const summary = summarize(
    parseMetrics(
      metricsText({ stores: { [STORE_A]: { ok: 90, errors: 10, slow: 6 } } }),
    ),
  );
  assert.equal(summary.startTime, 1_700_000_000);
  assert.equal(summary.groups.all.requests, 100);
  assert.equal(summary.groups[STORE_A].errors, 10);
  assert.deepEqual(summary.groups.all.errorRoutes, {
    "POST /v1/customer/stores/:slug/me/orders": 10,
  });
  assert.equal(p95Bound(summary.groups.all.buckets), 5); // 6 of 100 took 3 s
  assert.equal(p95Bound({ 0.1: 96, 5: 100, "+Inf": 100 }), 0.1);
  assert.equal(p95Bound({ 10: 90, "+Inf": 100 }), Infinity);
  assert.equal(p95Bound({ "+Inf": 0 }), null);
});

test("API down: alerts after two failed checks, once, repeats hourly and announces recovery", async () => {
  const h = await harness();
  try {
    assert.deepEqual((await h.check()).sent, []);
    h.api.ready = 503;
    assert.deepEqual(
      (await h.check()).sent,
      [],
      "one failure is not an outage",
    );
    const fired = await h.check();
    assert.equal(fired.code, 0);
    assert.equal(fired.sent.length, 1);
    assert.match(
      fired.sent[0],
      /^\[WhiteOven · piloto\]\n🔴 CRÍTICO: API indisponível/,
    );
    assert.match(
      fired.sent[0],
      /2 verificações seguidas desde 2026-11-01 12:02 UTC \(HTTP 503\)/,
    );
    assert.deepEqual(
      h.api.auth.length,
      1,
      "metrics are not read while the API is down",
    );

    for (let minute = 0; minute < 59; minute++)
      assert.deepEqual((await h.check()).sent, []);
    const reminder = await h.check();
    assert.match(
      reminder.sent[0],
      /CRÍTICO \(ainda ativo\): API indisponível: \/health\/ready falhou em 62/,
    );

    h.api.ready = 200;
    const resolved = await h.check();
    assert.match(resolved.sent[0], /✅ Resolvido: API indisponível/);
    assert.deepEqual(h.state().alerts, {});
    assert.deepEqual((await h.check()).sent, []);
  } finally {
    await h.close();
  }
});

test("an unreachable API counts as down, and a failed webhook is retried on the next check", async () => {
  const h = await harness({ MONITOR_DOWN_AFTER: "1" });
  try {
    await h.check();
    const down = await harness({ MONITOR_DOWN_AFTER: "1" });
    await down.close(); // nothing listens on its port any more
    const config = { ...h.config, apiUrl: new URL(down.env.MONITOR_API_URL) };
    h.hook.status = 500;
    const failed = await runCheck(config, { now: () => h.now() + MINUTE });
    assert.equal(failed, 1, "exit 1 when the alert could not be delivered");
    assert.equal(h.hook.posts.length, 1);
    h.hook.status = 204;
    const retried = await runCheck(config, { now: () => h.now() + 2 * MINUTE });
    assert.equal(retried, 0);
    assert.equal(h.hook.posts.length, 2);
    assert.match(
      h.hook.posts[1].text,
      /API indisponível.*sem conexão: ECONNREFUSED/,
    );
    assert.equal(
      await runCheck(config, { now: () => h.now() + 3 * MINUTE }),
      0,
    );
    assert.equal(h.hook.posts.length, 2, "delivered once");
  } finally {
    await h.close();
  }
});

test("error rate per store: the failing store and the total alert, a quiet store does not", async () => {
  const h = await harness();
  try {
    h.api.metrics = metricsText({
      stores: { [STORE_A]: { ok: 0 }, [STORE_B]: { ok: 0 } },
    });
    await h.check();
    // Store A: 30 of 40 fail. Store B: 5 requests, all failing, below MONITOR_MIN_REQUESTS.
    h.api.metrics = metricsText({
      stores: { [STORE_A]: { ok: 10, errors: 30 }, [STORE_B]: { errors: 5 } },
    });
    const { sent } = await h.check();
    assert.equal(sent.length, 1, "one message per check");
    const lines = sent[0].split("\n").slice(1);
    assert.equal(lines.length, 2);
    assert.match(
      lines[0],
      new RegExp(`CRÍTICO: Erros 5xx em loja ${STORE_A}: 75,0% \\(30 de 40`),
    );
    assert.match(
      lines[1],
      /CRÍTICO: Erros 5xx em todas as lojas: 77,8% \(35 de 45 requisições nos últimos 1 min\)\. Rotas: POST \/v1\/customer\/stores\/:slug\/me\/orders \(35\)/,
    );
    assert.doesNotMatch(sent[0], new RegExp(STORE_B));

    // The window keeps the failures for 10 minutes, then healthy traffic resolves both.
    for (let minute = 0; minute < 9; minute++)
      assert.deepEqual((await h.check()).sent, []);
    h.api.metrics = metricsText({
      stores: { [STORE_A]: { ok: 200, errors: 30 }, [STORE_B]: { errors: 5 } },
    });
    const resolved = await h.check();
    assert.equal(resolved.sent.length, 1);
    assert.equal(resolved.sent[0].match(/✅ Resolvido: Erros 5xx/g)?.length, 2);
  } finally {
    await h.close();
  }
});

test("latency: alerts when the p95 bucket passes the limit", async () => {
  const h = await harness();
  try {
    await h.check();
    h.api.metrics = metricsText({
      stores: { [STORE_A]: { ok: 100, slow: 4 } },
    });
    assert.deepEqual((await h.check()).sent, [], "4% slow keeps the p95 fast");
    h.api.metrics = metricsText({
      stores: { [STORE_A]: { ok: 200, slow: 20 } },
    });
    const { sent } = await h.check(11 * MINUTE);
    assert.match(
      sent[0],
      new RegExp(
        `ATENÇÃO: Latência alta em loja ${STORE_A}: p95 até 5 s \\(limite 2,5 s\\) em 100 requisições nos últimos 11 min`,
      ),
    );
    assert.match(sent[0], /Latência alta em todas as lojas/);
  } finally {
    await h.close();
  }
});

test("a restart starts the window over instead of reading reset counters as traffic", async () => {
  const h = await harness();
  try {
    h.api.metrics = metricsText({
      stores: { [STORE_A]: { ok: 1000, errors: 2 } },
    });
    await h.check();
    h.api.metrics = metricsText({
      start: 1_700_000_900,
      stores: { [STORE_A]: { ok: 1, errors: 40 } },
    });
    assert.deepEqual(
      (await h.check()).sent,
      [],
      "no baseline yet after the restart",
    );
    assert.equal(h.state().snapshots.length, 1);
    h.api.metrics = metricsText({
      start: 1_700_000_900,
      stores: { [STORE_A]: { ok: 1, errors: 80 } },
    });
    assert.match((await h.check()).sent[0], /Erros 5xx em loja/);
  } finally {
    await h.close();
  }
});

test("background job failures and an unreadable /metrics are warnings", async () => {
  const h = await harness();
  try {
    h.api.metrics = metricsText({ jobs: { push_delivery: 0 } });
    await h.check();
    h.api.metrics = metricsText({ jobs: { push_delivery: 3 } });
    assert.match(
      (await h.check()).sent[0],
      /ATENÇÃO: Falhas no job push_delivery: 3 nos últimos 1 min/,
    );

    h.api.metricsStatus = 500;
    assert.deepEqual((await h.check()).sent, []);
    const unavailable = await h.check();
    assert.match(
      unavailable.sent[0],
      /ATENÇÃO: Métricas indisponíveis: \/metrics falhou em 2 verificações seguidas .*\(HTTP 500\)/,
    );
    h.api.metricsStatus = 200;
    assert.match(
      (await h.check()).sent[0],
      /✅ Resolvido: Métricas indisponíveis/,
    );
    assert.ok(h.api.auth.every((value) => value === `Bearer ${TOKEN}`));
  } finally {
    await h.close();
  }
});

test("messages, state and logs carry no URL, token or webhook key", async () => {
  const h = await harness({
    MONITOR_WEBHOOK_FORMAT: "json",
    MONITOR_DOWN_AFTER: "1",
  });
  try {
    h.api.ready = 503;
    await h.check();
    const [post] = h.hook.posts;
    assert.equal(post.source, "whiteoven-api-monitor");
    assert.equal(post.environment, "piloto");
    assert.deepEqual(
      post.alerts.map(({ key, state, severity }) => ({ key, state, severity })),
      [{ key: "api_down", state: "firing", severity: "critical" }],
    );
    const stored = readFileSync(h.env.MONITOR_STATE_FILE, "utf8");
    for (const text of [JSON.stringify(post), stored])
      assert.doesNotMatch(text, /127\.0\.0\.1|monitor-token|secret-hook-key/);
  } finally {
    await h.close();
  }
});

test("discord format and the test alert", async () => {
  const h = await harness({ MONITOR_WEBHOOK_FORMAT: "discord" });
  try {
    const config = loadMonitorConfig(h.env, "test-alert");
    assert.equal(await sendTestAlert(config, { now: h.now }), 0);
    assert.deepEqual(Object.keys(h.hook.posts[0]), ["content"]);
    assert.match(
      h.hook.posts[0].content,
      /^\[WhiteOven · piloto\]\n🧪 Teste do canal de alertas da API em 2026-11-01 12:00 UTC/,
    );
    h.hook.status = 403;
    assert.equal(await sendTestAlert(config, { now: h.now }), 1);
  } finally {
    await h.close();
  }
});

test("evaluate resolves alerts of a store that disappeared from the metrics", () => {
  const config = loadMonitorConfig({
    MONITOR_API_URL: "http://api.internal:3000",
    MONITOR_WEBHOOK_URL: "https://hooks.example.test/x",
  });
  let state = emptyState();
  state.alerts[`error_rate:${STORE_B}`] = {
    severity: "critical",
    firing: true,
    since: 0,
    summary: "x",
    notified: "firing",
    lastNotifiedAt: 0,
  };
  const scrape = (requests) => ({
    ok: true,
    summary: summarize(
      parseMetrics(metricsText({ stores: { [STORE_A]: { ok: requests } } })),
    ),
  });
  state = evaluate(config, state, MINUTE, { ok: true }, scrape(10));
  state = evaluate(config, state, 2 * MINUTE, { ok: true }, scrape(20));
  assert.equal(state.alerts[`error_rate:${STORE_B}`].firing, false);
});

function run(args, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["ops/api-monitor.mjs", ...args], {
      cwd: root,
      env: { PATH: process.env.PATH, ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

test("command line: exit codes, JSON log lines, and a lock against overlapping checks", async () => {
  const h = await harness({ MONITOR_DOWN_AFTER: "1" });
  try {
    const usage = await run([], h.env);
    assert.equal(usage.code, 2);
    const invalid = await run(["check"], {
      ...h.env,
      MONITOR_WEBHOOK_URL: "http://hooks.example.test/abc-secret",
    });
    assert.equal(invalid.code, 2);
    assert.match(invalid.stderr, /MONITOR_WEBHOOK_URL must use https/);
    assert.doesNotMatch(invalid.stderr, /abc-secret/);

    h.api.ready = 503;
    const checked = await run(["check"], h.env);
    assert.equal(checked.code, 0);
    assert.equal(h.hook.posts.length, 1);
    const lines = checked.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map(({ msg }) => msg),
      ["alerts sent", "check completed"],
    );
    assert.deepEqual(lines[1].firing, ["api_down"]);
    assert.doesNotMatch(
      checked.stdout,
      /127\.0\.0\.1|monitor-token|secret-hook-key/,
    );
    assert.ok(!existsSync(`${h.env.MONITOR_STATE_FILE}.lock`));

    // A live lock (another check running) skips this one without touching the state.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(`${h.env.MONITOR_STATE_FILE}.lock`, "");
    const skipped = await run(["check"], h.env);
    assert.equal(skipped.code, 0);
    assert.match(skipped.stdout, /previous check still running/);

    const testAlert = await run(["test-alert"], {
      MONITOR_WEBHOOK_URL: h.env.MONITOR_WEBHOOK_URL,
    });
    assert.equal(testAlert.code, 0);
    assert.match(h.hook.posts.at(-1).text, /Teste do canal de alertas/);
  } finally {
    await h.close();
  }
});

// --- P1: job failures and the first scrape ---------------------------------------------------

const seconds = (ms) => Math.floor(ms / 1000);
const jobLine = (text) => text.find((line) => /Falhas no job/.test(line));

test("first scrape of an old API process: a zero counter and a non-zero one alert nothing", async () => {
  const h = await harness();
  try {
    h.api.metrics = metricsText({ jobs: { push_delivery: 0 } });
    assert.deepEqual((await h.check()).sent, []);
    assert.equal(h.state().unconfirmed, undefined);
  } finally {
    await h.close();
  }
  const g = await harness();
  try {
    // The process started long before the window: these failures may be days old.
    g.api.metrics = metricsText({ jobs: { push_delivery: 2 } });
    assert.deepEqual((await g.check()).sent, []);
    assert.deepEqual(g.state().unconfirmed, { push_delivery: 2 });
    // Without new failures it stays quiet.
    assert.deepEqual((await g.check()).sent, []);
    assert.equal(g.state().unconfirmed, undefined);
  } finally {
    await g.close();
  }
});

test("a failure right before the first scrape alerts when the API process started inside the window", async () => {
  const h = await harness();
  try {
    const start = seconds(h.now()) - 2 * 60; // 3 minutes before the first check
    h.api.metrics = metricsText({ start, jobs: { order_accept_timeout: 1 } });
    const { sent } = await h.check();
    assert.match(
      sent[0],
      /ATENÇÃO: Falhas no job order_accept_timeout: 1 nos últimos 3 min/,
    );
  } finally {
    await h.close();
  }
});

test("failures after the first scrape alert once, accumulate quietly and resolve outside the window", async () => {
  const h = await harness();
  try {
    h.api.metrics = metricsText({ jobs: { push_delivery: 4 } });
    await h.check();
    h.api.metrics = metricsText({ jobs: { push_delivery: 5 } });
    assert.match(
      jobLine((await h.check()).sent),
      /push_delivery: 1 nos últimos 1 min/,
    );
    h.api.metrics = metricsText({ jobs: { push_delivery: 7 } });
    assert.deepEqual((await h.check()).sent, [], "still firing, not repeated");
    assert.match(
      h.state().alerts["job_failures:push_delivery"].summary,
      /: 3 nos últimos 2 min/,
    );
    // No new failure for a whole window: the old ones fall out and the alert resolves.
    for (let minute = 0; minute < 9; minute++)
      assert.deepEqual((await h.check()).sent, []);
    assert.match(
      (await h.check()).sent[0],
      /✅ Resolvido: Falhas no job push_delivery/,
    );
    for (let minute = 0; minute < 15; minute++)
      assert.deepEqual((await h.check()).sent, []);
  } finally {
    await h.close();
  }
});

test("a restarted monitor keeps its window from the state file", async () => {
  const h = await harness();
  try {
    h.api.metrics = metricsText({ jobs: { push_delivery: 0 } });
    await h.check();
    // A new monitor process: nothing in memory, the same state file.
    const restarted = loadMonitorConfig(h.env);
    h.api.metrics = metricsText({ jobs: { push_delivery: 1 } });
    assert.equal(await runCheck(restarted, { now: () => h.now() + MINUTE }), 0);
    assert.match(h.hook.posts.at(-1).text, /Falhas no job push_delivery: 1/);
  } finally {
    await h.close();
  }
});

test("an API restart resets the counters: no false alert, and failures since the restart are seen", async () => {
  const h = await harness();
  try {
    h.api.metrics = metricsText({ jobs: { push_delivery: 9 } });
    await h.check();
    await h.check();
    // New process one minute old with a reset counter.
    const start = seconds(h.now());
    h.api.metrics = metricsText({ start, jobs: { push_delivery: 0 } });
    assert.deepEqual((await h.check()).sent, []);
    h.api.metrics = metricsText({ start, jobs: { push_delivery: 2 } });
    assert.match(
      jobLine((await h.check()).sent),
      /push_delivery: 2 nos últimos 2 min/,
    );
  } finally {
    await h.close();
  }
});

// --- P2: no data is not recovery and not continuity ------------------------------------------

/** Fires error_rate (store A and total), latency and a job alert, all announced. */
async function incident(h) {
  h.api.metrics = metricsText({
    stores: { [STORE_A]: { ok: 0 } },
    jobs: { push_delivery: 0 },
  });
  await h.check();
  h.api.metrics = metricsText({
    stores: { [STORE_A]: { ok: 10, errors: 30, slow: 40 } },
    jobs: { push_delivery: 1 },
  });
  const { sent } = await h.check();
  assert.match(sent[0], /Erros 5xx em loja/);
  assert.match(sent[0], /Latência alta em loja/);
  assert.match(sent[0], /Falhas no job push_delivery/);
}

const metricKeys = (state) =>
  Object.keys(state.alerts).filter((key) =>
    /^(error_rate|latency|job_failures):/.test(key),
  );

test("/metrics down: firing metric alerts go stale, with no reminder and no resolution for hours", async () => {
  const h = await harness();
  try {
    await incident(h);
    h.api.metricsStatus = 500;
    const sent = [];
    for (let minute = 0; minute < 150; minute++)
      sent.push(...(await h.check()).sent);
    const text = sent.join("\n");
    assert.doesNotMatch(text, /Erros 5xx|Latência|Falhas no job|Resolvido/);
    // Only the outage of /metrics itself: fired once, then repeated hourly.
    assert.equal(text.match(/Métricas indisponíveis/g)?.length, 3);
    assert.match(text, /sem lembrete nem resolução/);
    const state = h.state();
    assert.equal(metricKeys(state).length, 5);
    assert.ok(
      metricKeys(state).every(
        (key) => state.alerts[key].firing && state.alerts[key].staleSince,
      ),
    );
  } finally {
    await h.close();
  }
});

test("metrics back and the problem continues: one confirmed reminder, then the normal cadence", async () => {
  const h = await harness();
  try {
    await incident(h);
    h.api.metricsStatus = 500;
    for (let minute = 0; minute < 70; minute++) await h.check();
    h.api.metricsStatus = 200;
    h.api.metrics = metricsText({
      stores: { [STORE_A]: { ok: 20, errors: 300, slow: 320 } },
      jobs: { push_delivery: 3 },
    });
    const { sent } = await h.check();
    assert.equal(sent.length, 1, "a single message");
    const lines = sent[0].split("\n").slice(1);
    assert.ok(
      lines.some((line) => /Resolvido: Métricas indisponíveis/.test(line)),
    );
    assert.equal(
      lines.filter((line) =>
        /\(ainda ativo\): (Erros|Latência|Falhas)/.test(line),
      ).length,
      5,
    );
    assert.doesNotMatch(sent[0], /sem métricas desde/);
    assert.ok(
      metricKeys(h.state()).every((key) => !h.state().alerts[key].staleSince),
    );
    assert.deepEqual((await h.check()).sent, []);
  } finally {
    await h.close();
  }
});

test("metrics back and the problem is gone: the alerts resolve then, not before", async () => {
  const h = await harness();
  try {
    await incident(h);
    h.api.metricsStatus = 500;
    for (let minute = 0; minute < 20; minute++) await h.check();
    h.api.metricsStatus = 200;
    h.api.metrics = metricsText({
      stores: { [STORE_A]: { ok: 500, errors: 30, slow: 40 } },
      jobs: { push_delivery: 1 },
    });
    const { sent } = await h.check();
    assert.equal(
      sent[0].match(/✅ Resolvido: (Erros|Latência|Falhas)/g)?.length,
      5,
    );
    assert.deepEqual(metricKeys(h.state()), []);
  } finally {
    await h.close();
  }
});

test("API down hides the metrics too, and a restart during the outage resolves from fresh counters", async () => {
  const h = await harness();
  try {
    await incident(h);
    h.api.ready = 503;
    const down = [];
    for (let minute = 0; minute < 90; minute++)
      down.push(...(await h.check()).sent);
    assert.doesNotMatch(
      down.join("\n"),
      /Erros 5xx|Latência|Falhas no job|Resolvido/,
    );
    assert.equal(down.join("\n").match(/API indisponível/g)?.length, 2);

    // Back as a new process that started 20 s before the check.
    h.api.ready = 200;
    const start = seconds(h.now() + MINUTE) - 20;
    h.api.metrics = metricsText({
      start,
      stores: { [STORE_A]: { ok: 30 } },
      jobs: { push_delivery: 0 },
    });
    const back = await h.check();
    assert.match(back.sent[0], /✅ Resolvido: API indisponível/);
    // The process started inside the window: its counters are evidence right away.
    assert.equal(
      back.sent[0].match(/✅ Resolvido: (Erros|Latência|Falhas)/g)?.length,
      5,
    );
    assert.deepEqual((await h.check()).sent, []);
  } finally {
    await h.close();
  }
});

test("a resolution that fails to send is sent once on the next check", async () => {
  const h = await harness();
  try {
    await incident(h);
    h.api.metricsStatus = 500;
    await h.check();
    h.api.metricsStatus = 200;
    h.api.metrics = metricsText({
      stores: { [STORE_A]: { ok: 400, errors: 30, slow: 40 } },
      jobs: { push_delivery: 1 },
    });
    h.hook.status = 500;
    // Past the window, so the incident's requests no longer count.
    const failed = await h.check(11 * MINUTE);
    assert.equal(failed.code, 1);
    h.hook.status = 200;
    const retried = await h.check();
    assert.equal(retried.code, 0);
    assert.equal(
      retried.sent[0].match(/✅ Resolvido: (Erros|Latência|Falhas)/g)?.length,
      5,
    );
    assert.deepEqual((await h.check()).sent, []);
  } finally {
    await h.close();
  }
});

test("an alert that never got out before /metrics fell says when it was last seen", async () => {
  const h = await harness();
  try {
    h.api.metrics = metricsText({ jobs: { push_delivery: 0 } });
    await h.check();
    h.api.metrics = metricsText({ jobs: { push_delivery: 1 } });
    h.hook.status = 500;
    assert.equal((await h.check()).code, 1);
    h.hook.status = 200;
    h.api.metricsStatus = 500;
    const { sent } = await h.check();
    assert.match(
      sent[0],
      /Falhas no job push_delivery: 1 nos últimos 1 min\..* Visto às 2026-11-01 12:02 UTC; sem métricas desde 2026-11-01 12:03 UTC, não confirmado depois disso\./,
    );
    // The next message is /metrics' own outage; the stale job alert is not repeated.
    const next = (await h.check()).sent.join("\n");
    assert.match(next, /Métricas indisponíveis/);
    assert.doesNotMatch(next, /Falhas no job/);
  } finally {
    await h.close();
  }
});

test("a state file from before this change still loads and works", async () => {
  const h = await harness();
  try {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      h.env.MONITOR_STATE_FILE,
      JSON.stringify({
        version: 1,
        ready: { failures: 0, since: null, lastProblem: null },
        metrics: { failures: 0, since: null, lastProblem: null },
        snapshots: [],
        alerts: {
          "job_failures:push_delivery": {
            severity: "warning",
            firing: true,
            since: h.now() - 5 * MINUTE,
            summary: "Falhas no job push_delivery: 1 nos últimos 1 min.",
            notified: "firing",
            lastNotifiedAt: h.now() - 5 * MINUTE,
          },
        },
      }),
    );
    h.api.metricsStatus = 500;
    for (let minute = 0; minute < 70; minute++)
      assert.doesNotMatch((await h.check()).sent.join(""), /Falhas no job/);
  } finally {
    await h.close();
  }
});
