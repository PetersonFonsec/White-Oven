#!/usr/bin/env node
// API monitor and alerts (M7.4, ADR 0032). No dependency and no vendor: Node 22 and a webhook.
//
//   node ops/api-monitor.mjs check        one check (cron or a systemd timer, every minute)
//   node ops/api-monitor.mjs watch        checks every MONITOR_INTERVAL_SECONDS until stopped
//   node ops/api-monitor.mjs test-alert   sends one test message, to prove the channel works
//
// Every check probes GET /health/ready and, with MONITOR_METRICS_TOKEN, reads GET /metrics. Alerts:
//   api_down               critical  /health/ready failed MONITOR_DOWN_AFTER checks in a row
//   metrics_unavailable    warning   /metrics failed MONITOR_DOWN_AFTER checks in a row
//   error_rate:<group>     critical  5xx share >= MONITOR_ERROR_RATE over the window
//   latency:<group>        warning   p95 above MONITOR_LATENCY_P95_SECONDS over the window
//   job_failures:<job>     warning   a background job failed within the window
// A group is "all" (every store) or one tenant id; rate alerts need MONITOR_MIN_REQUESTS
// requests in the window. One message per check carries every change (firing, still firing after
// MONITOR_REPEAT_MINUTES, resolved). A message that fails to send is sent again on the next check,
// and the check exits 1 so cron or systemd can flag it.
//
// The metrics carry no personal data (tenant ids, route templates, status codes), and neither do
// the messages and the monitor's own log lines. URLs and the token are never logged.
// Runbook: docs/operations/observability.md.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "..");
const STATE_VERSION = 1;
const LOCK_STALE_MS = 5 * 60_000;
const MAX_SNAPSHOTS = 240;
const MAX_TEXT = 1_900; // Discord refuses content above 2000 characters.
const FORMATS = ["text", "discord", "json"];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export class MonitorConfigError extends Error {
  constructor(problems) {
    super(`Invalid monitor configuration:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

/** Validates the environment. Messages name variables, never their values. */
export function loadMonitorConfig(env, mode = "check") {
  const problems = [];
  const url = (name, { required, webhook }) => {
    const raw = env[name] ?? "";
    if (raw === "") {
      if (required) problems.push(`${name} is required`);
      return null;
    }
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      problems.push(`${name} must be an http(s) URL`);
      return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      problems.push(`${name} must be an http(s) URL`);
    else if (parsed.username || parsed.password)
      problems.push(`${name} must not carry credentials`);
    else if (!webhook && (parsed.search || parsed.hash))
      problems.push(`${name} must not have a query string or fragment`);
    else if (
      webhook &&
      parsed.protocol === "http:" &&
      !LOOPBACK.has(parsed.hostname)
    )
      problems.push(`${name} must use https`);
    else return parsed;
    return null;
  };
  const int = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = /^\d{1,7}$/.test(raw) ? Number(raw) : Number.NaN;
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };
  const decimal = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = /^\d{1,4}(\.\d{1,4})?$/.test(raw) ? Number(raw) : Number.NaN;
    if (!(value > min && value <= max)) {
      problems.push(`${name} must be a number above ${min} and at most ${max}`);
      return fallback;
    }
    return value;
  };

  const apiUrl = url("MONITOR_API_URL", {
    required: mode !== "test-alert",
    webhook: false,
  });
  const webhookUrl = url("MONITOR_WEBHOOK_URL", {
    required: true,
    webhook: true,
  });
  const metricsToken = env.MONITOR_METRICS_TOKEN || null;
  if (
    metricsToken !== null &&
    !/^[A-Za-z0-9._~+/=-]{32,512}$/.test(metricsToken)
  )
    problems.push(
      "MONITOR_METRICS_TOKEN must match API_METRICS_TOKEN's format",
    );
  const format = env.MONITOR_WEBHOOK_FORMAT || "text";
  if (!FORMATS.includes(format))
    problems.push(
      `MONITOR_WEBHOOK_FORMAT must be one of: ${FORMATS.join(", ")}`,
    );
  const environment = env.MONITOR_ENVIRONMENT || "whiteoven";
  if (!/^[A-Za-z0-9 ._-]{1,40}$/.test(environment))
    problems.push(
      "MONITOR_ENVIRONMENT must be 1-40 letters, digits, spaces or ._-",
    );
  const stateFile = env.MONITOR_STATE_FILE
    ? isAbsolute(env.MONITOR_STATE_FILE)
      ? env.MONITOR_STATE_FILE
      : resolve(ROOT, env.MONITOR_STATE_FILE)
    : join(ROOT, ".ops-state", "api-monitor", "state.json");

  const config = {
    apiUrl,
    webhookUrl,
    metricsToken,
    format,
    environment,
    stateFile,
    downAfter: int("MONITOR_DOWN_AFTER", 2, 1, 10),
    windowMs: int("MONITOR_WINDOW_MINUTES", 10, 1, 60) * 60_000,
    minRequests: int("MONITOR_MIN_REQUESTS", 20, 1, 100_000),
    errorRate: decimal("MONITOR_ERROR_RATE", 0.05, 0, 1),
    latencyP95Seconds: decimal("MONITOR_LATENCY_P95_SECONDS", 2.5, 0, 60),
    repeatMs: int("MONITOR_REPEAT_MINUTES", 60, 5, 1440) * 60_000,
    intervalMs: int("MONITOR_INTERVAL_SECONDS", 60, 15, 3600) * 1000,
    timeoutMs: int("MONITOR_TIMEOUT_SECONDS", 5, 1, 30) * 1000,
  };
  if (problems.length) throw new MonitorConfigError(problems);
  return Object.freeze(config);
}

// --- Prometheus text -------------------------------------------------------------------------

const LINE = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+\d+)?$/;
const LABEL = /([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"\s*,?\s*/gy;

export function parseMetrics(text) {
  const series = [];
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const match = LINE.exec(line);
    if (!match) continue;
    const labels = {};
    if (match[2]) {
      LABEL.lastIndex = 0;
      let label;
      while ((label = LABEL.exec(match[2])))
        labels[label[1]] = label[2].replace(/\\(.)/g, (_, c) =>
          c === "n" ? "\n" : c,
        );
    }
    const value = match[3] === "+Inf" ? Infinity : Number(match[3]);
    if (Number.isFinite(value) || value === Infinity)
      series.push({ name: match[1], labels, value });
  }
  return series;
}

const emptyGroup = () => ({
  requests: 0,
  errors: 0,
  errorRoutes: {},
  buckets: {},
});

/**
 * Totals per group ("all" and each tenant label) and per job: everything a check compares
 * between two scrapes. Small enough to keep one per check for the whole window.
 */
export function summarize(series) {
  const groups = { all: emptyGroup() };
  const jobs = {};
  let startTime = null;
  const groupsOf = (tenant) => {
    groups[tenant] ??= emptyGroup();
    return [groups.all, groups[tenant]];
  };
  for (const { name, labels, value } of series) {
    if (name === "process_start_time_seconds") startTime = value;
    else if (name === "whiteoven_http_requests_total") {
      for (const group of groupsOf(labels.tenant ?? "none")) {
        group.requests += value;
        if (/^5\d\d$/.test(labels.status ?? "")) {
          group.errors += value;
          const route = `${labels.method ?? "?"} ${labels.route ?? "?"}`;
          group.errorRoutes[route] = (group.errorRoutes[route] ?? 0) + value;
        }
      }
    } else if (name === "whiteoven_http_request_duration_seconds_bucket") {
      for (const group of groupsOf(labels.tenant ?? "none"))
        group.buckets[labels.le] = (group.buckets[labels.le] ?? 0) + value;
    } else if (name === "whiteoven_background_job_failures_total")
      jobs[labels.job] = (jobs[labels.job] ?? 0) + value;
  }
  return { startTime, groups, jobs };
}

/** Upper bound of the bucket that holds the 95th percentile; Infinity past the last bucket. */
export function p95Bound(buckets) {
  const bounds = Object.keys(buckets)
    .map((le) => (le === "+Inf" ? Infinity : Number(le)))
    .sort((a, b) => a - b);
  const total = buckets["+Inf"] ?? 0;
  if (total <= 0) return null;
  const target = Math.ceil(total * 0.95);
  for (const bound of bounds) {
    const key = bound === Infinity ? "+Inf" : String(bound);
    if ((buckets[key] ?? 0) >= target) return bound;
  }
  return Infinity;
}

const minus = (current, base) => {
  const buckets = {};
  for (const [le, value] of Object.entries(current.buckets))
    buckets[le] = Math.max(0, value - (base?.buckets[le] ?? 0));
  const errorRoutes = {};
  for (const [route, value] of Object.entries(current.errorRoutes)) {
    const delta = value - (base?.errorRoutes[route] ?? 0);
    if (delta > 0) errorRoutes[route] = delta;
  }
  return {
    requests: Math.max(0, current.requests - (base?.requests ?? 0)),
    errors: Math.max(0, current.errors - (base?.errors ?? 0)),
    errorRoutes,
    buckets,
  };
};

// --- Evaluation ------------------------------------------------------------------------------

const groupName = (group) =>
  group === "all"
    ? "todas as lojas"
    : group === "none"
      ? "rotas sem loja"
      : group === "_overflow"
        ? "lojas acima do limite de séries"
        : `loja ${group}`;
const utc = (ms) =>
  `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const percent = (ratio) => `${(ratio * 100).toFixed(1).replace(".", ",")}%`;
const seconds = (bound) =>
  bound === Infinity
    ? "mais de 10 s"
    : `até ${String(bound).replace(".", ",")} s`;

export function emptyState() {
  return {
    version: STATE_VERSION,
    ready: { failures: 0, since: null, lastProblem: null },
    metrics: { failures: 0, since: null, lastProblem: null },
    snapshots: [],
    alerts: {},
  };
}

/**
 * Pure decision for one check. `ready` is { ok, problem }; `scrape` is null (not attempted),
 * { ok: false, problem } or { ok: true, summary }. Returns the new state; alert notifications are
 * decided by `pendingNotifications`.
 */
export function evaluate(config, previous, now, ready, scrape) {
  const state = structuredClone(previous);
  const set = (key, severity, firing, summary) => {
    const alert = state.alerts[key];
    if (firing) {
      state.alerts[key] = {
        severity,
        firing: true,
        since: alert?.firing ? alert.since : now,
        summary,
        notified: alert?.notified ?? null,
        lastNotifiedAt: alert?.lastNotifiedAt ?? null,
      };
    } else if (alert?.firing) {
      state.alerts[key] = { ...alert, firing: false, resolvedAt: now };
    }
  };

  if (ready.ok) {
    state.ready = { failures: 0, since: null, lastProblem: null };
    set("api_down", "critical", false);
  } else {
    state.ready.failures++;
    state.ready.since ??= now;
    state.ready.lastProblem = ready.problem;
    if (state.ready.failures >= config.downAfter)
      set(
        "api_down",
        "critical",
        true,
        `API indisponível: /health/ready falhou em ${state.ready.failures} verificações seguidas desde ${utc(state.ready.since)} (${ready.problem}).`,
      );
  }

  if (!scrape) return state;
  if (!scrape.ok) {
    state.metrics.failures++;
    state.metrics.since ??= now;
    state.metrics.lastProblem = scrape.problem;
    if (state.metrics.failures >= config.downAfter)
      set(
        "metrics_unavailable",
        "warning",
        true,
        `Métricas indisponíveis: /metrics falhou em ${state.metrics.failures} verificações seguidas desde ${utc(state.metrics.since)} (${scrape.problem}). Os alertas de erro e latência estão parados.`,
      );
    return state;
  }
  state.metrics = { failures: 0, since: null, lastProblem: null };
  set("metrics_unavailable", "warning", false);

  const current = scrape.summary;
  // A restart resets every counter: the window starts over.
  if (state.snapshots.at(-1)?.startTime !== current.startTime)
    state.snapshots = [];
  state.snapshots.push({
    at: now,
    startTime: current.startTime,
    summary: current,
  });
  // Keep the newest snapshot at least one window old as the baseline, drop older ones.
  while (
    state.snapshots.length > 2 &&
    state.snapshots[1].at <= now - config.windowMs
  )
    state.snapshots.shift();
  while (state.snapshots.length > MAX_SNAPSHOTS) state.snapshots.shift();
  const baseline = state.snapshots.length > 1 ? state.snapshots[0] : null;
  if (!baseline) return state;

  const minutes = Math.max(1, Math.round((now - baseline.at) / 60_000));
  const evaluated = new Set();
  for (const [group, totals] of Object.entries(current.groups)) {
    const delta = minus(totals, baseline.summary.groups[group]);
    const enough = delta.requests >= config.minRequests;

    const errorKey = `error_rate:${group}`;
    evaluated.add(errorKey);
    const ratio = delta.requests ? delta.errors / delta.requests : 0;
    const routes = Object.entries(delta.errorRoutes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([route, count]) => `${route} (${count})`)
      .join(", ");
    set(
      errorKey,
      "critical",
      enough && ratio >= config.errorRate,
      `Erros 5xx em ${groupName(group)}: ${percent(ratio)} (${delta.errors} de ${delta.requests} requisições nos últimos ${minutes} min). Rotas: ${routes || "-"}.`,
    );

    const latencyKey = `latency:${group}`;
    evaluated.add(latencyKey);
    const bound = p95Bound(delta.buckets);
    set(
      latencyKey,
      "warning",
      enough && bound !== null && bound > config.latencyP95Seconds,
      `Latência alta em ${groupName(group)}: p95 ${seconds(bound)} (limite ${String(config.latencyP95Seconds).replace(".", ",")} s) em ${delta.requests} requisições nos últimos ${minutes} min.`,
    );
  }
  for (const [job, total] of Object.entries(current.jobs)) {
    const failures = total - (baseline.summary.jobs[job] ?? 0);
    const key = `job_failures:${job}`;
    evaluated.add(key);
    set(
      key,
      "warning",
      failures > 0,
      `Falhas no job ${job}: ${failures} nos últimos ${minutes} min. Veja os logs da API (msg "... failed").`,
    );
  }
  // Groups that disappeared (a restart, a removed store) cannot stay firing forever.
  for (const key of Object.keys(state.alerts))
    if (/^(error_rate|latency|job_failures):/.test(key) && !evaluated.has(key))
      set(key, state.alerts[key].severity, false);
  return state;
}

/** Alerts to announce now: new, still firing past the repeat interval, or resolved. */
export function pendingNotifications(config, state, now) {
  const pending = [];
  for (const [key, alert] of Object.entries(state.alerts)) {
    if (alert.firing && alert.notified !== "firing")
      pending.push({ key, kind: "firing", alert });
    else if (
      alert.firing &&
      now - (alert.lastNotifiedAt ?? 0) >= config.repeatMs
    )
      pending.push({ key, kind: "reminder", alert });
    else if (!alert.firing && alert.notified === "firing")
      pending.push({ key, kind: "resolved", alert });
  }
  const order = { critical: 0, warning: 1 };
  return pending.sort(
    (a, b) =>
      (a.kind === "resolved") - (b.kind === "resolved") ||
      order[a.alert.severity] - order[b.alert.severity] ||
      a.key.localeCompare(b.key),
  );
}

/** Marks what was sent and forgets alerts that are resolved and announced (or never were). */
export function settle(state, sent, now) {
  const next = structuredClone(state);
  for (const { key, kind } of sent) {
    const alert = next.alerts[key];
    if (!alert) continue;
    if (kind === "resolved") alert.notified = "resolved";
    else {
      alert.notified = "firing";
      alert.lastNotifiedAt = now;
    }
  }
  for (const [key, alert] of Object.entries(next.alerts))
    if (!alert.firing && alert.notified !== "firing") delete next.alerts[key];
  return next;
}

export function messageText(config, notifications) {
  const icon = { critical: "🔴", warning: "🟠" };
  const lines = notifications.map(({ kind, alert }) =>
    kind === "resolved"
      ? `✅ Resolvido: ${alert.summary}`
      : kind === "test"
        ? `🧪 ${alert.summary}`
        : `${icon[alert.severity]} ${alert.severity === "critical" ? "CRÍTICO" : "ATENÇÃO"}${kind === "reminder" ? " (ainda ativo)" : ""}: ${alert.summary}`,
  );
  const text = `[WhiteOven · ${config.environment}]\n${lines.join("\n")}`;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

export function webhookBody(config, notifications, now) {
  const text = messageText(config, notifications);
  if (config.format === "discord") return { content: text };
  if (config.format === "text") return { text };
  return {
    source: "whiteoven-api-monitor",
    environment: config.environment,
    sentAt: new Date(now).toISOString(),
    text,
    alerts: notifications.map(({ key, kind, alert }) => ({
      key,
      state: kind,
      severity: alert.severity,
      since: alert.since ? new Date(alert.since).toISOString() : null,
      summary: alert.summary,
    })),
  };
}

// --- I/O -------------------------------------------------------------------------------------

const log = (level, msg, fields = {}) =>
  process.stdout.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, msg, ...fields })}\n`,
  );

/** Short reason for a failed request, never the URL. */
const problemOf = (error) =>
  error?.name === "TimeoutError" || error?.name === "AbortError"
    ? "tempo esgotado"
    : `sem conexão: ${error?.cause?.code ?? error?.name ?? "erro"}`;

async function probeReady(config, fetchImpl) {
  try {
    const response = await fetchImpl(new URL("/health/ready", config.apiUrl), {
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "manual",
    });
    const body = await response.text();
    if (response.status !== 200)
      return { ok: false, problem: `HTTP ${response.status}` };
    try {
      if (JSON.parse(body).status === "ok") return { ok: true };
    } catch {
      // falls through
    }
    return { ok: false, problem: "resposta inesperada" };
  } catch (error) {
    return { ok: false, problem: problemOf(error) };
  }
}

async function scrapeMetrics(config, fetchImpl) {
  try {
    const response = await fetchImpl(new URL("/metrics", config.apiUrl), {
      headers: { authorization: `Bearer ${config.metricsToken}` },
      signal: AbortSignal.timeout(config.timeoutMs),
      redirect: "manual",
    });
    const body = await response.text();
    if (response.status !== 200)
      return { ok: false, problem: `HTTP ${response.status}` };
    const summary = summarize(parseMetrics(body));
    if (summary.startTime === null)
      return { ok: false, problem: "resposta sem process_start_time_seconds" };
    return { ok: true, summary };
  } catch (error) {
    return { ok: false, problem: problemOf(error) };
  }
}

async function send(config, notifications, now, fetchImpl) {
  try {
    const response = await fetchImpl(config.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(webhookBody(config, notifications, now)),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.status >= 200 && response.status < 300
      ? { ok: true }
      : { ok: false, problem: `HTTP ${response.status}` };
  } catch (error) {
    return { ok: false, problem: problemOf(error) };
  }
}

export function readState(file) {
  if (!existsSync(file)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed?.version === STATE_VERSION && parsed.alerts && parsed.ready)
      return parsed;
  } catch {
    // falls through
  }
  log("warn", "monitor state unreadable: starting over");
  return emptyState();
}

export function writeState(file, state) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, JSON.stringify(state));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

/** One check at a time per state file: a slow check never overlaps the next one. */
function acquireLock(file) {
  const lock = `${file}.lock`;
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      return () => rmSync(lock, { force: true });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue;
      }
      if (age < LOCK_STALE_MS) return null;
      rmSync(lock, { force: true });
    }
  }
  return null;
}

/** Exit code: 0 checked (alerts may be firing), 1 a message could not be sent. */
export async function runCheck(
  config,
  { fetchImpl = fetch, now = Date.now } = {},
) {
  const release = acquireLock(config.stateFile);
  if (!release) {
    log("warn", "previous check still running: skipped");
    return 0;
  }
  try {
    const previous = readState(config.stateFile);
    const ready = await probeReady(config, fetchImpl);
    const scrape =
      ready.ok && config.metricsToken
        ? await scrapeMetrics(config, fetchImpl)
        : null;
    const at = now();
    let state = evaluate(config, previous, at, ready, scrape);
    const pending = pendingNotifications(config, state, at);
    let code = 0;
    if (pending.length) {
      const result = await send(config, pending, at, fetchImpl);
      if (result.ok) {
        state = settle(state, pending, at);
        log("info", "alerts sent", {
          alerts: pending.map(({ key, kind }) => `${kind}:${key}`),
        });
      } else {
        code = 1;
        log("error", "alert webhook failed: will retry on the next check", {
          problem: result.problem,
          alerts: pending.map(({ key, kind }) => `${kind}:${key}`),
        });
      }
    } else state = settle(state, [], at);
    writeState(config.stateFile, state);
    log("info", "check completed", {
      ready: ready.ok,
      metrics: scrape ? scrape.ok : null,
      firing: Object.entries(state.alerts)
        .filter(([, alert]) => alert.firing)
        .map(([key]) => key),
    });
    return code;
  } finally {
    release();
  }
}

export async function sendTestAlert(
  config,
  { fetchImpl = fetch, now = Date.now } = {},
) {
  const at = now();
  const result = await send(
    config,
    [
      {
        key: "monitor_test",
        kind: "test",
        alert: {
          severity: "warning",
          since: at,
          summary: `Teste do canal de alertas da API em ${utc(at)}. Nenhuma ação necessária.`,
        },
      },
    ],
    at,
    fetchImpl,
  );
  if (result.ok) log("info", "test alert sent");
  else log("error", "test alert failed", { problem: result.problem });
  return result.ok ? 0 : 1;
}

async function main(argv) {
  const mode = argv[0];
  if (!["check", "watch", "test-alert"].includes(mode)) {
    process.stderr.write(
      "usage: node ops/api-monitor.mjs check|watch|test-alert\n",
    );
    return 2;
  }
  let config;
  try {
    config = loadMonitorConfig(process.env, mode);
  } catch (error) {
    if (!(error instanceof MonitorConfigError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (mode === "test-alert") return sendTestAlert(config);
  if (!config.metricsToken)
    log(
      "warn",
      "MONITOR_METRICS_TOKEN not set: only the availability alert runs",
    );
  if (mode === "check") return runCheck(config);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      stopping = true;
    });
  while (!stopping) {
    const started = Date.now();
    await runCheck(config).catch((error) =>
      log("error", "check crashed", { errorType: error?.constructor?.name }),
    );
    const wait = Math.max(0, config.intervalMs - (Date.now() - started));
    for (let waited = 0; waited < wait && !stopping; waited += 250)
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(250, wait - waited)),
      );
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      process.stderr.write(
        `monitor failed: ${error?.constructor?.name ?? typeof error}\n`,
      );
      process.exit(1);
    },
  );
