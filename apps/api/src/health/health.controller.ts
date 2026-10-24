import { Controller, Get, Header } from "@nestjs/common";
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from "@nestjs/swagger";

export class HealthBody {
  @ApiProperty({ enum: ["ok"], example: "ok" })
  status!: "ok";
}

/**
 * Liveness only: answers while the process serves HTTP. Database readiness arrives with
 * PostgreSQL in M1.2. Intentionally reveals no version, environment or dependency detail.
 */
@ApiTags("health")
@Controller("health")
export class HealthController {
  @Get()
  @Header("Cache-Control", "no-store")
  @ApiOperation({ summary: "Liveness probe" })
  @ApiOkResponse({ type: HealthBody })
  check(): HealthBody {
    return { status: "ok" };
  }
}
