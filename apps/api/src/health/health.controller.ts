import { Controller, Get, Header, HttpStatus, Inject } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiServiceUnavailableResponse,
  ApiTags,
} from "@nestjs/swagger";
import { MikroORM } from "@mikro-orm/postgresql";
import { PublicRoute } from "../auth/route-access";
import { ApiError, ApiErrorBody } from "../errors/api-error";

export class HealthBody {
  @ApiProperty({ enum: ["ok"], example: "ok" })
  status!: "ok";
}

export const READINESS_TIMEOUT_MS = 2_000;

/**
 * `/health` is liveness only: answers while the process serves HTTP. `/health/ready` also
 * requires a database round trip. Neither reveals version, environment or dependency detail.
 */
@ApiTags("health")
@PublicRoute()
@Controller("health")
export class HealthController {
  constructor(@Inject(MikroORM) private readonly orm: MikroORM) {}

  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Liveness probe" })
  @ApiOkResponse({ type: HealthBody })
  check(): HealthBody {
    return { status: "ok" };
  }

  @Get("ready")
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Readiness probe (database reachable)" })
  @ApiOkResponse({ type: HealthBody })
  @ApiServiceUnavailableResponse({ type: ApiErrorBody })
  async ready(): Promise<HealthBody> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), READINESS_TIMEOUT_MS);
    });
    const probe = this.orm.em
      .getConnection()
      .execute("select 1")
      .then(() => true)
      .catch(() => false);
    const ok = await Promise.race([probe, timeout]).finally(() =>
      clearTimeout(timer),
    );
    if (!ok)
      throw new ApiError(
        HttpStatus.SERVICE_UNAVAILABLE,
        "NOT_READY",
        "Service not ready.",
      );
    return { status: "ok" };
  }
}
