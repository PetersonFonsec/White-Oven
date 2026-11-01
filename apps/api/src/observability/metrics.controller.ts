import { createHash, timingSafeEqual } from "node:crypto";
import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Inject,
  Req,
} from "@nestjs/common";
import { ApiExcludeController } from "@nestjs/swagger";
import type { Request } from "express";
import { PublicRoute } from "../auth/route-access";
import { API_CONFIG, type ApiConfig } from "../config/config";
import { ApiError } from "../errors/api-error";
import { ApiMetrics } from "./metrics";

export const METRICS_PATH = "metrics";

const digest = (value: string): Buffer =>
  createHash("sha256").update(value).digest();

/**
 * `GET /metrics` (outside `/v1`): Prometheus text for the monitor (ADR 0032). It answers only
 * when `API_METRICS_TOKEN` is set and the request carries it as a bearer token; otherwise it is a
 * plain 404, so a deployment without monitoring exposes nothing. The proxy should still keep
 * the path off the public site (docs/operations/observability.md).
 */
@ApiExcludeController()
@PublicRoute()
@Controller(METRICS_PATH)
export class MetricsController {
  private readonly expected: Buffer | null;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    private readonly metrics: ApiMetrics,
  ) {
    this.expected = config.metricsToken ? digest(config.metricsToken) : null;
  }

  @Get()
  @Header("Cache-Control", "no-store")
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  render(@Req() req: Request): string {
    if (!this.expected)
      throw new ApiError(
        HttpStatus.NOT_FOUND,
        "NOT_FOUND",
        "Resource not found.",
      );
    const header = req.get("authorization") ?? "";
    const match = /^Bearer ([^\s]{1,512})$/.exec(header);
    // Compare digests: equal length always, so the comparison time says nothing about the token.
    if (!match || !timingSafeEqual(digest(match[1]!), this.expected))
      throw new ApiError(
        HttpStatus.UNAUTHORIZED,
        "UNAUTHORIZED",
        "Authentication required.",
      );
    return this.metrics.render();
  }
}
