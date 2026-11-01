import { randomUUID } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { JsonLogger } from "./json-logger";
import type { ApiMetrics } from "../observability/metrics";

export const REQUEST_ID_HEADER = "x-request-id";
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,128}$/;

const requestIds = new WeakMap<Request, string>();
const requestTenants = new WeakMap<Request, string>();

export const requestIdOf = (req: Request): string =>
  requestIds.get(req) ?? "unknown";

/** The tenant a surface guard bound to the request, if any (logs and metrics only). */
export const requestTenantOf = (req: Request): string | undefined =>
  requestTenants.get(req);

/** Set by tenant surface guards; the access log line then carries `tenantId`. */
export const setRequestTenant = (req: Request, tenantId: string): void => {
  requestTenants.set(req, tenantId);
};

/**
 * Assigns a request id (reusing a well-formed upstream one) and writes one access log line
 * per request. Only the matched route template is logged: no query string, body, headers,
 * IP or user agent, so URLs with identifiers or personal data never reach the logs. The same
 * fields feed the request metrics (ADR 0032), except the metrics route itself.
 */
export function requestContext(logger: JsonLogger, metrics?: ApiMetrics) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const requestId =
      incoming && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
    requestIds.set(req, requestId);
    res.setHeader(REQUEST_ID_HEADER, requestId);

    const started = process.hrtime.bigint();
    res.on("finish", () => {
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const routePath = req.route?.path;
      const route =
        typeof routePath === "string"
          ? `${req.baseUrl}${routePath}`
          : "<unmatched>";
      const tenantId = requestTenants.get(req);
      if (metrics && route !== "/metrics")
        metrics.observeRequest({
          tenantId,
          method: req.method,
          route,
          statusCode: res.statusCode,
          durationSeconds: durationMs / 1000,
        });
      logger.write(
        res.statusCode >= 500 ? "error" : "info",
        "request completed",
        {
          requestId,
          method: req.method,
          route,
          ...(tenantId ? { tenantId } : {}),
          statusCode: res.statusCode,
          durationMs: Math.round(durationMs * 10) / 10,
        },
      );
    });
    next();
  };
}
