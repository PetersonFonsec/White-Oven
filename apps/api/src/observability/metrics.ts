/**
 * In-process metrics in the Prometheus text format (M7.4, ADR 0032). No client library and no
 * vendor: the API keeps a few counters and one histogram, and `GET /metrics` renders them for the
 * monitor (`ops/api-monitor.mjs`) or any Prometheus-compatible scraper.
 *
 * Label values come only from what the API itself decides: the tenant UUID read from the database
 * by a guard, the matched route template, a normalized method, the status code and fixed enums.
 * Never a path, query string, header, body, IP, user agent, e-mail or name.
 */

export const LATENCY_BUCKETS_SECONDS = [
  0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
] as const;

/** Upper bound of live series per metric; past it, new label sets fold into one overflow series. */
export const MAX_SERIES_PER_METRIC = 5_000;

/** Label value for requests that reached no tenant guard (public health, platform, unmatched). */
export const NO_TENANT = "none";
export const OVERFLOW = "_overflow";

const METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

export const ORDER_STATUSES = [
  "PLACED",
  "PREPARING",
  "READY",
  "OUT_FOR_DELIVERY",
  "COMPLETED",
  "CANCELED",
  "REJECTED",
] as const;
export const ORDER_ACTORS = ["CUSTOMER", "STAFF", "SYSTEM"] as const;
export const BACKGROUND_JOBS = [
  "order_accept_timeout",
  "push_delivery",
] as const;

export type OrderStatusLabel = (typeof ORDER_STATUSES)[number];
export type OrderActorLabel = (typeof ORDER_ACTORS)[number];
export type BackgroundJob = (typeof BACKGROUND_JOBS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Express route templates: `/v1/customer/stores/:slug/me/orders`, `/lojas/*path`. */
const ROUTE_TEMPLATE = /^\/[A-Za-z0-9/:*._-]{0,200}$/;
export const UNMATCHED_ROUTE = "<unmatched>";

/** A tenant label is the guard's UUID or `none`; anything else is a programming error. */
const tenantLabel = (tenantId: string | undefined): string =>
  tenantId && UUID.test(tenantId) ? tenantId.toLowerCase() : NO_TENANT;

export const normalizeMethod = (method: string): string =>
  METHODS.has(method) ? method : "OTHER";

export const normalizeRoute = (route: string | undefined): string =>
  route && ROUTE_TEMPLATE.test(route) ? route : UNMATCHED_ROUTE;

type Labels = Record<string, string>;

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"');

const renderLabels = (labels: Labels): string => {
  const entries = Object.entries(labels);
  return entries.length
    ? `{${entries.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(",")}}`
    : "";
};

/** A family of series keyed by label values in a fixed order, with a hard series ceiling. */
class Family<T> {
  private readonly series = new Map<string, { labels: Labels; value: T }>();
  dropped = 0;

  constructor(
    readonly name: string,
    readonly help: string,
    readonly type: "counter" | "histogram",
    private readonly labelNames: readonly string[],
    private readonly create: () => T,
    private readonly maxSeries: number,
  ) {}

  get(values: readonly string[]): T {
    const key = values.join("\u0000");
    let entry = this.series.get(key);
    if (!entry) {
      if (this.series.size >= this.maxSeries) {
        // Never evict a live series (counters would go backwards); fold the rest into one.
        this.dropped++;
        const overflowKey = this.labelNames.map(() => OVERFLOW).join("\u0000");
        entry = this.series.get(overflowKey);
        if (!entry) {
          entry = {
            labels: Object.fromEntries(
              this.labelNames.map((name) => [name, OVERFLOW]),
            ),
            value: this.create(),
          };
          // The overflow series itself may exceed the ceiling by one.
          this.series.set(overflowKey, entry);
        }
        return entry.value;
      }
      entry = {
        labels: Object.fromEntries(
          this.labelNames.map((name, index) => [name, values[index]!]),
        ),
        value: this.create(),
      };
      this.series.set(key, entry);
    }
    return entry.value;
  }

  entries(): Iterable<{ labels: Labels; value: T }> {
    return this.series.values();
  }

  get size(): number {
    return this.series.size;
  }
}

interface CounterValue {
  value: number;
}
interface HistogramValue {
  buckets: number[];
  sum: number;
  count: number;
}

export interface RequestObservation {
  tenantId?: string;
  method: string;
  route?: string;
  statusCode: number;
  durationSeconds: number;
}

export class ApiMetrics {
  private readonly requests: Family<CounterValue>;
  private readonly latency: Family<HistogramValue>;
  private readonly ordersCreated: Family<CounterValue>;
  private readonly orderTransitions: Family<CounterValue>;
  private readonly unhandled: Family<CounterValue>;
  private readonly jobFailures: Family<CounterValue>;
  private readonly startTimeSeconds: number;

  constructor(
    now: () => number = Date.now,
    maxSeries: number = MAX_SERIES_PER_METRIC,
  ) {
    this.startTimeSeconds = Math.floor(now() / 1000);
    const counter = () => ({ value: 0 });
    this.requests = new Family(
      "whiteoven_http_requests_total",
      "HTTP requests answered, by tenant, route template, method and status code.",
      "counter",
      ["tenant", "route", "method", "status"],
      counter,
      maxSeries,
    );
    this.latency = new Family(
      "whiteoven_http_request_duration_seconds",
      "Time to answer HTTP requests, by tenant, route template and method.",
      "histogram",
      ["tenant", "route", "method"],
      () => ({
        buckets: LATENCY_BUCKETS_SECONDS.map(() => 0),
        sum: 0,
        count: 0,
      }),
      maxSeries,
    );
    this.ordersCreated = new Family(
      "whiteoven_orders_created_total",
      "Orders placed (an idempotent replay is not counted), by tenant.",
      "counter",
      ["tenant"],
      counter,
      maxSeries,
    );
    this.orderTransitions = new Family(
      "whiteoven_order_transitions_total",
      "Order status changes committed (replays not counted), by tenant, new status and actor.",
      "counter",
      ["tenant", "to", "actor"],
      counter,
      maxSeries,
    );
    this.unhandled = new Family(
      "whiteoven_unhandled_errors_total",
      "Requests answered with INTERNAL_ERROR, by tenant.",
      "counter",
      ["tenant"],
      counter,
      maxSeries,
    );
    this.jobFailures = new Family(
      "whiteoven_background_job_failures_total",
      "Failed background job batches or runs, by job.",
      "counter",
      ["job"],
      counter,
      maxSeries,
    );
  }

  observeRequest(observation: RequestObservation): void {
    const tenant = tenantLabel(observation.tenantId);
    const route = normalizeRoute(observation.route);
    const method = normalizeMethod(observation.method);
    const status =
      Number.isInteger(observation.statusCode) &&
      observation.statusCode >= 100 &&
      observation.statusCode <= 599
        ? String(observation.statusCode)
        : "0";
    this.requests.get([tenant, route, method, status]).value++;
    const histogram = this.latency.get([tenant, route, method]);
    const seconds = Math.max(0, observation.durationSeconds);
    LATENCY_BUCKETS_SECONDS.forEach((bound, index) => {
      if (seconds <= bound) histogram.buckets[index]!++;
    });
    histogram.sum += seconds;
    histogram.count++;
  }

  orderCreated(tenantId: string): void {
    this.ordersCreated.get([tenantLabel(tenantId)]).value++;
  }

  orderTransition(
    tenantId: string,
    to: OrderStatusLabel,
    actor: OrderActorLabel,
  ): void {
    this.orderTransitions.get([tenantLabel(tenantId), to, actor]).value++;
  }

  unhandledError(tenantId: string | undefined): void {
    this.unhandled.get([tenantLabel(tenantId)]).value++;
  }

  jobFailed(job: BackgroundJob): void {
    this.jobFailures.get([job]).value++;
  }

  /** Prometheus text exposition format 0.0.4. */
  render(): string {
    const lines: string[] = [];
    const counters = [
      this.requests,
      this.ordersCreated,
      this.orderTransitions,
      this.unhandled,
      this.jobFailures,
    ];
    for (const family of counters) {
      lines.push(`# HELP ${family.name} ${family.help}`);
      lines.push(`# TYPE ${family.name} counter`);
      for (const { labels, value } of family.entries())
        lines.push(`${family.name}${renderLabels(labels)} ${value.value}`);
    }

    const latency = this.latency;
    lines.push(`# HELP ${latency.name} ${latency.help}`);
    lines.push(`# TYPE ${latency.name} histogram`);
    for (const { labels, value } of latency.entries()) {
      LATENCY_BUCKETS_SECONDS.forEach((bound, index) => {
        lines.push(
          `${latency.name}_bucket${renderLabels({ ...labels, le: String(bound) })} ${value.buckets[index]}`,
        );
      });
      lines.push(
        `${latency.name}_bucket${renderLabels({ ...labels, le: "+Inf" })} ${value.count}`,
      );
      lines.push(`${latency.name}_sum${renderLabels(labels)} ${value.sum}`);
      lines.push(`${latency.name}_count${renderLabels(labels)} ${value.count}`);
    }

    const all = [...counters, latency];
    lines.push(
      "# HELP whiteoven_metrics_series_dropped_total Observations folded into an overflow series.",
    );
    lines.push("# TYPE whiteoven_metrics_series_dropped_total counter");
    for (const family of all)
      lines.push(
        `whiteoven_metrics_series_dropped_total{metric="${family.name}"} ${family.dropped}`,
      );

    lines.push(
      "# HELP process_start_time_seconds Start time of the process since the Unix epoch.",
    );
    lines.push("# TYPE process_start_time_seconds gauge");
    lines.push(`process_start_time_seconds ${this.startTimeSeconds}`);
    lines.push("# HELP process_resident_memory_bytes Resident memory size.");
    lines.push("# TYPE process_resident_memory_bytes gauge");
    lines.push(`process_resident_memory_bytes ${process.memoryUsage.rss()}`);
    return `${lines.join("\n")}\n`;
  }
}
