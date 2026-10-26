import {
  Body,
  Controller,
  Headers,
  HttpStatus,
  Post,
  Res,
  HttpCode,
  Param,
  Get,
  Query,
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
import { OrderService, type StaffOrderSection } from "./order.service";
import {
  REJECTION_REASONS,
  ORDER_STATUSES,
  type OrderStatus,
  type RejectionReason,
} from "./order-lifecycle-rules";
import { AdminRoute } from "../auth/staff.guard";

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

class TransitionBody {
  @ApiProperty({ enum: ORDER_STATUSES }) from!: OrderStatus;
  @ApiProperty({ enum: ORDER_STATUSES }) to!: OrderStatus;
  @ApiPropertyOptional({ enum: REJECTION_REASONS })
  reasonCode?: RejectionReason;
  @ApiPropertyOptional({ maxLength: 280 }) reasonText?: string;
}

function parseTransition(raw: unknown): TransitionBody {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw invalid(["transition"]);
  const value = raw as Record<string, unknown>;
  const allowed = ["from", "to", "reasonCode", "reasonText"];
  if (
    Object.keys(value).some((key) => !allowed.includes(key)) ||
    !ORDER_STATUSES.includes(value["from"] as OrderStatus) ||
    !ORDER_STATUSES.includes(value["to"] as OrderStatus) ||
    (value["reasonCode"] !== undefined &&
      !REJECTION_REASONS.includes(value["reasonCode"] as RejectionReason)) ||
    (value["reasonText"] !== undefined &&
      (typeof value["reasonText"] !== "string" ||
        [...value["reasonText"]].length > 280))
  )
    throw invalid(["transition"]);
  return value as unknown as TransitionBody;
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

  @Post(":orderId/transitions")
  @CustomerRoute("createOrder")
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: TransitionBody })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({
    summary: "Apply an idempotent order transition",
    description:
      "200 returns `change`, the transition confirmed by this key, and `order`, the current order with its history. A retry with the same key and command returns the same `change`; `order` may have advanced since the original request. Reusing the key for another command returns 409 IDEMPOTENCY_KEY_REUSED. A new command with stale `from` returns 409 ORDER_STATE_CONFLICT.",
  })
  transitionCustomer(
    @Param("orderId") orderId: string,
    @Body() raw: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Headers("x-request-id") requestId?: string,
  ) {
    const body = parseTransition(raw);
    if (
      !UUID.test(orderId) ||
      !key ||
      !UUID.test(key) ||
      body.from !== "PLACED" ||
      body.to !== "CANCELED" ||
      body.reasonCode !== "CUSTOMER_REQUEST" ||
      body.reasonText
    )
      throw invalid(["transition"]);
    return this.orders.transition({
      orderId,
      from: body.from,
      to: body.to,
      reasonCode: body.reasonCode,
      idempotencyKey: key.toLowerCase(),
      requestId,
    });
  }
}

@ApiTags("admin")
@Controller("admin/orders")
export class AdminOrderController {
  constructor(private readonly orders: OrderService) {}

  @Get()
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @ApiOperation({
    summary: "List a page of active or closed orders for the active store",
    description:
      "Returns up to 100 orders with a nextCursor when more are available. Active orders are oldest first; closed history is newest first. The queues have independent cursors. The active store comes from the verified staff session.",
  })
  list(
    @Query() query: Record<string, string | undefined>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const section = query["section"];
    const rawCursor = query["cursor"];
    if (section !== "active" && section !== "closed")
      throw invalid(["section"]);
    const cursor = rawCursor === undefined ? undefined : Number(rawCursor);
    if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 1))
      throw invalid(["cursor"]);
    res.setHeader("Cache-Control", "no-store");
    return this.orders.listForStaff(section as StaffOrderSection, cursor);
  }

  @Get(":orderId")
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @ApiOperation({ summary: "Read an order in the active store" })
  get(
    @Param("orderId") orderId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!UUID.test(orderId)) throw invalid(["orderId"]);
    res.setHeader("Cache-Control", "no-store");
    return this.orders.getForStaff(orderId);
  }

  @Post(":orderId/transitions")
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: TransitionBody })
  @ApiHeader({ name: "Idempotency-Key", required: true })
  @ApiOperation({
    summary: "Apply an idempotent order transition",
    description:
      "200 returns `change`, the transition confirmed by this key, and `order`, the current order with its history. A retry with the same key and command returns the same `change`; `order` may have advanced since the original request. Reusing the key for another command returns 409 IDEMPOTENCY_KEY_REUSED. A new command with stale `from` returns 409 ORDER_STATE_CONFLICT. During tenant suspension, only the OWNER may perform a valid transition to CANCELED or REJECTED.",
  })
  transition(
    @Param("orderId") orderId: string,
    @Body() raw: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Headers("x-request-id") requestId?: string,
  ) {
    const body = parseTransition(raw);
    if (!UUID.test(orderId) || !key || !UUID.test(key))
      throw invalid(["transition"]);
    return this.orders.transition({
      orderId,
      from: body.from,
      to: body.to,
      reasonCode: body.reasonCode,
      reasonText: body.reasonText,
      idempotencyKey: key.toLowerCase(),
      requestId,
    });
  }
}
