import {
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
  HttpCode,
} from "@nestjs/common";
import {
  ApiBody,
  ApiHeader,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  OmitType,
} from "@nestjs/swagger";
import type { Response } from "express";
import { ApiError } from "../errors/api-error";
import { CustomerRoute } from "../customer/customer.guard";
import {
  FULFILLMENTS,
  ORDER_CENTS_MAX,
  ORDER_LINES_MAX,
  PAYMENT_METHODS,
  validateOrderRequest,
} from "./order-rules";
import { OrderService } from "./order.service";

class QuoteBody {
  @ApiProperty({ enum: FULFILLMENTS }) fulfillment!: string;
  @ApiPropertyOptional({
    format: "uuid",
    nullable: true,
    description: "A saved address of the customer; required for DELIVERY",
  })
  addressId?: string | null;
  @ApiProperty({ enum: PAYMENT_METHODS }) paymentMethod!: string;
  @ApiPropertyOptional({ nullable: true, description: "CASH only" })
  changeForCents?: number | null;
  @ApiPropertyOptional({ maxLength: 280, nullable: true }) notes?:
    string | null;
  @ApiProperty({
    maxItems: ORDER_LINES_MAX,
    description:
      'Lines: { kind: "PIZZA", pizza: PizzaConfiguration } or { kind: "PRODUCT", productId, quantity }. No prices.',
    type: "array",
    items: { type: "object" },
  })
  items!: unknown[];
  @ApiPropertyOptional({
    nullable: true,
    minimum: 0,
    maximum: ORDER_CENTS_MAX,
    description:
      "The total the app showed. Optional here: never used to price, a different total only sets priceChanged.",
  })
  expectedTotalCents?: number | null;
}

class CreateOrderBody extends OmitType(QuoteBody, [
  "expectedTotalCents",
] as const) {
  @ApiProperty({
    minimum: 0,
    maximum: ORDER_CENTS_MAX,
    description:
      "The total the customer confirmed, in cents. Required: a different server total is 409 ORDER_PRICE_CHANGED and nothing is created.",
  })
  expectedTotalCents!: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invalid = (paths: string[]) =>
  new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "VALIDATION_FAILED",
    "Invalid request body.",
    { errors: paths.map((path) => ({ code: "VALIDATION_FAILED", path })) },
  );

/**
 * Orders of the signed-in customer (M4.3, ADR 0018). The API prices every line from the catalog;
 * the app sends configurations, never prices. Both routes need an ACTIVE store (`createOrder`).
 */
@ApiTags("customer")
@Controller("customer/stores/:storeSlug/me/orders")
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @Post("quote")
  @CustomerRoute("createOrder")
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: QuoteBody })
  @ApiOperation({
    summary: "Price an order without placing it",
    description:
      "409 STORE_CLOSED or STORE_NOT_CONFIGURED; 422 ORDER_INVALID with the offending paths (ORDER_TOTAL_EXCEEDED above maxTotalCents).",
  })
  quote(@Body() raw: unknown, @Res({ passthrough: true }) res: Response) {
    const result = validateOrderRequest(raw);
    if (!result.ok) throw invalid(result.paths);
    res.setHeader("Cache-Control", "no-store");
    return this.orders.quote(result.value);
  }

  @Post()
  @CustomerRoute("createOrder")
  @ApiBody({ type: CreateOrderBody })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "A UUID per confirmation; a retry reuses it with the same body (valid for 24 hours).",
  })
  @ApiOperation({
    summary: "Place an order",
    description:
      "201 when created; 200 with the same order when the key and body repeat, even if prices changed since. 422 VALIDATION_FAILED without a valid expectedTotalCents; 409 IDEMPOTENCY_CONFLICT when the key was used for another body, ORDER_PRICE_CHANGED when expectedTotalCents differs from the server total (nothing is created).",
  })
  async create(
    @Body() raw: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = validateOrderRequest(raw, { requireExpectedTotal: true });
    const paths = [
      ...(typeof key === "string" && UUID.test(key) ? [] : ["Idempotency-Key"]),
      ...(result.ok ? [] : result.paths),
    ];
    if (paths.length || !result.ok) throw invalid(paths);
    const { created, order } = await this.orders.create(
      result.value,
      key!.toLowerCase(),
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    res.setHeader("Cache-Control", "no-store");
    return order;
  }
}
