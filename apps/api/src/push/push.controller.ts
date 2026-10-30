import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Res,
} from "@nestjs/common";
import { ApiBody, ApiOperation, ApiProperty, ApiTags } from "@nestjs/swagger";
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
}

/**
 * Opt-in order notifications of the signed-in device (M5.5, ADR 0027). The device is the current
 * customer session: logging out, a revoked session or a deleted account ends its notifications.
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
    const token = (raw as { token?: unknown } | null)?.token;
    if (
      typeof raw !== "object" ||
      raw === null ||
      Array.isArray(raw) ||
      Object.keys(raw).some((key) => key !== "token") ||
      typeof token !== "string" ||
      !EXPO_PUSH_TOKEN.test(token)
    )
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "VALIDATION_FAILED",
        "Invalid request body.",
        { errors: [{ code: "VALIDATION_FAILED", path: "token" }] },
      );
    res.setHeader("Cache-Control", "no-store");
    return this.push.register(token);
  }

  @Delete()
  @CustomerRoute()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Opt out: stop this device's notifications" })
  async unregister(): Promise<void> {
    await this.push.unregister();
  }
}
