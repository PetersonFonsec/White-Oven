import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Query,
  Res,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiQuery,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";
import { ApiError } from "../errors/api-error";
import { CustomerRoute } from "../customer/customer.guard";
import { EXPO_PUSH_TOKEN } from "./push-rules";
import { type PushDeviceStatus, PushService } from "./push.service";

class PushDeviceBody {
  @ApiProperty({
    example: "ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]",
    description: "From expo-notifications getExpoPushTokenAsync",
  })
  token!: string;
  @ApiProperty({
    format: "uuid",
    description:
      "Random id the app created for this installation and keeps in its secure storage",
  })
  installationId!: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const invalid = (paths: string[]) =>
  new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "VALIDATION_FAILED",
    "Invalid request body.",
    { errors: paths.map((path) => ({ code: "VALIDATION_FAILED", path })) },
  );

/**
 * Opt-in order notifications of an app installation (M5.5, ADR 0027), subscribed by the signed-in
 * session: logging out, a revoked session or a deleted account ends its notifications.
 */
@ApiTags("customer")
@Controller("customer/stores/:storeSlug/me/push-device")
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get()
  @CustomerRoute()
  @ApiOperation({ summary: "Whether this device receives order notifications" })
  status(@Res({ passthrough: true }) res: Response): Promise<PushDeviceStatus> {
    res.setHeader("Cache-Control", "no-store");
    return this.push.status();
  }

  @Put()
  @CustomerRoute("customerAccountWrite")
  @ApiBody({ type: PushDeviceBody })
  @ApiOperation({
    summary: "Opt in: send this device's order status notifications",
    description:
      "The token replaces any previous one of this session. Only the order number and state are sent.",
  })
  register(
    @Body() raw: unknown,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PushDeviceStatus> {
    const body = raw as Record<string, unknown> | null;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      throw invalid([""]);
    const paths = [
      ...(typeof body!.token === "string" && EXPO_PUSH_TOKEN.test(body!.token)
        ? []
        : ["token"]),
      ...(typeof body!.installationId === "string" &&
      UUID.test(body!.installationId)
        ? []
        : ["installationId"]),
      ...Object.keys(raw).filter(
        (key) => key !== "token" && key !== "installationId",
      ),
    ];
    if (paths.length) throw invalid(paths);
    res.setHeader("Cache-Control", "no-store");
    return this.push.register(
      body!.token as string,
      body!.installationId as string,
    );
  }

  @Delete()
  @CustomerRoute()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiQuery({
    name: "installationId",
    required: false,
    description:
      "Also ends this installation's subscription by an account signed in before",
  })
  @ApiOperation({ summary: "Opt out: stop this device's notifications" })
  async unregister(
    @Query("installationId") installationId?: unknown,
  ): Promise<void> {
    if (
      installationId !== undefined &&
      (typeof installationId !== "string" || !UUID.test(installationId))
    )
      throw invalid(["installationId"]);
    await this.push.unregister(installationId ?? null);
  }
}
