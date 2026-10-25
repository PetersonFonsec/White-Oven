import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Put,
  Req,
} from "@nestjs/common";
import {
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";
import { AdminRoute } from "../auth/staff.guard";
import { ApiError } from "../errors/api-error";
import { requestIdOf } from "../logging/request-context";
import { BRAND_COLOR_TOKENS, validateBrandTheme } from "./brand-rules";
import {
  FULFILLMENT_MODES,
  PAYMENT_METHODS,
  validateOpeningHours,
  validateStoreSettings,
} from "./store-rules";
import {
  PAUSE_MINUTES,
  type PauseMinutes,
  StoreService,
} from "./store.service";

class StoreSettingsBody {
  @ApiProperty({ enum: FULFILLMENT_MODES, isArray: true })
  fulfillmentModes!: string[];
  @ApiProperty({ minimum: 0 }) deliveryFeeCents!: number;
  @ApiProperty({ minimum: 0 }) minimumOrderCents!: number;
  @ApiProperty({ nullable: true, maxLength: 500 })
  deliveryAreaDescription!: string | null;
  @ApiProperty({ minimum: 1, maximum: 240 }) estimatedPrepMinutes!: number;
  @ApiProperty({ minimum: 1, maximum: 240 }) estimatedDeliveryMinutes!: number;
  @ApiProperty({ minimum: 1, maximum: 60 }) acceptTimeoutMinutes!: number;
  @ApiProperty({ enum: PAYMENT_METHODS, isArray: true })
  acceptedPaymentMethods!: string[];
  @ApiProperty({ nullable: true }) contactPhone!: string | null;
  @ApiProperty({ nullable: true, maxLength: 300 })
  pickupAddress!: string | null;
}
class TimeRangeBody {
  @ApiProperty({ example: "18:00" }) opensAt!: string;
  @ApiProperty({ example: "02:00" }) closesAt!: string;
}
class OpeningRuleBody extends TimeRangeBody {
  @ApiProperty({ minimum: 0, maximum: 6, description: "0 = Sunday" })
  weekday!: number;
}
class ClosureExceptionBody {
  @ApiProperty({ example: "2026-12-24" }) date!: string;
  @ApiProperty() closed!: boolean;
  @ApiProperty({ type: [TimeRangeBody] }) shifts!: TimeRangeBody[];
}
class OpeningHoursBody {
  @ApiProperty({ type: [OpeningRuleBody] }) rules!: OpeningRuleBody[];
  @ApiProperty({ type: [ClosureExceptionBody] })
  exceptions!: ClosureExceptionBody[];
}
class PauseBody {
  @ApiPropertyOptional({
    enum: PAUSE_MINUTES,
    nullable: true,
    description: "null pauses until someone reopens",
  })
  minutes!: PauseMinutes | null;
}

class BrandThemeBody {
  @ApiProperty({
    description: `Overrides of ${BRAND_COLOR_TOKENS.join(", ")} only, as #RRGGBB`,
    example: { primary: "#B3261E", onPrimary: "#FFFFFF" },
  })
  colorOverrides!: Record<string, string>;
  @ApiProperty({ nullable: true, format: "uuid" }) logoAssetId!: string | null;
  @ApiProperty({ nullable: true, format: "uuid" }) iconAssetId!: string | null;
}

const invalid = (code: string, errors: { code: string; path: string }[]) =>
  new ApiError(HttpStatus.UNPROCESSABLE_ENTITY, code, "Invalid request body.", {
    errors,
  });

@ApiTags("store")
@Controller("admin/store")
export class StoreController {
  constructor(private readonly store: StoreService) {}

  @Get("settings")
  @AdminRoute("OWNER", "MANAGER")
  @ApiOperation({ summary: "Get store settings, opening hours and pause" })
  get() {
    return this.store.get();
  }

  @Put("settings")
  @AdminRoute("OWNER")
  @ApiBody({ type: StoreSettingsBody })
  updateSettings(@Body() body: unknown, @Req() req: Request) {
    const result = validateStoreSettings(body);
    if (!result.ok) throw invalid("VALIDATION_FAILED", result.errors);
    return this.store.updateSettings(result.value, requestIdOf(req));
  }

  @Put("opening-hours")
  @AdminRoute("OWNER")
  @ApiBody({ type: OpeningHoursBody })
  @ApiOperation({
    summary: "Replace weekly opening rules and date exceptions",
    description:
      "Shifts may cross midnight; overlaps with the previous and next day are refused (422 OPENING_HOURS_INVALID with the offending paths).",
  })
  updateOpeningHours(@Body() body: unknown, @Req() req: Request) {
    const result = validateOpeningHours(body);
    if (!result.ok) throw invalid("OPENING_HOURS_INVALID", result.errors);
    return this.store.updateOpeningHours(result.value, requestIdOf(req));
  }

  @Get("brand")
  @AdminRoute("OWNER", "MANAGER")
  @ApiOperation({
    summary: "Get the brand theme, its resolved colors and the contrast rules",
  })
  getBrand() {
    return this.store.getBrand();
  }

  @Put("brand")
  @AdminRoute("OWNER")
  @ApiBody({ type: BrandThemeBody })
  @ApiOperation({
    summary: "Publish the brand theme",
    description:
      "Refused with 422 BRAND_THEME_INVALID when a locked token is sent, a color fails a contrast rule (details carry ratio and minimum), or an image is missing, too small or, for the icon, not square.",
  })
  updateBrand(@Body() body: unknown, @Req() req: Request) {
    const result = validateBrandTheme(body);
    if (!result.ok) throw invalid("BRAND_THEME_INVALID", result.errors);
    return this.store.updateBrand(result.value, requestIdOf(req));
  }

  @Get("pause")
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @ApiOperation({ summary: "Whether the store paused new orders" })
  getPause() {
    return this.store.getPause();
  }

  @Put("pause")
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @ApiBody({ type: PauseBody })
  @ApiOperation({
    summary: "Pause new orders for 15, 30 or 60 minutes, or until reopened",
  })
  pause(@Body() body: unknown, @Req() req: Request) {
    const minutes = (body as { minutes?: unknown } | null)?.minutes;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).join() !== "minutes" ||
      !(minutes === null || PAUSE_MINUTES.includes(minutes as PauseMinutes))
    )
      throw invalid("VALIDATION_FAILED", [
        { code: "VALIDATION_FAILED", path: "minutes" },
      ]);
    return this.store.pause(minutes as PauseMinutes | null, requestIdOf(req));
  }

  @Delete("pause")
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Reopen for new orders" })
  resume(@Req() req: Request) {
    return this.store.resume(requestIdOf(req));
  }
}
