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
import { OrderHistoryService } from "./order-history.service";
import {
  DAILY_REPORT_MAX_DAYS,
  INCIDENT_REPORTERS,
  INCIDENT_TEXT_MAX_LENGTH,
  INCIDENT_TYPES,
  INCIDENT_WINDOW_DAYS,
  ORDER_HISTORY_PAGE_SIZE,
  parseDailyReportQuery,
  parseOrderHistoryQuery,
  validateIncident,
  validateResolution,
} from "./order-history-rules";

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

class IncidentBody {
  @ApiProperty({ enum: INCIDENT_TYPES }) type!: string;
  @ApiProperty({ minLength: 1, maxLength: INCIDENT_TEXT_MAX_LENGTH })
  description!: string;
  @ApiProperty({
    enum: INCIDENT_REPORTERS,
    description: "CUSTOMER when the customer told the store; STAFF otherwise",
  })
  reportedBy!: string;
}

class ResolutionBody {
  @ApiPropertyOptional({ maxLength: INCIDENT_TEXT_MAX_LENGTH, nullable: true })
  resolutionNote?: string | null;
}

/** A request id worth keeping in the audit, or null. */
const auditRequestId = (value: string | undefined) =>
  typeof value === "string" && UUID.test(value) ? value : null;

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

function parseCustomerOrderCursor(
  query: Record<string, unknown>,
): number | null {
  if (
    Object.keys(query).some((key) => key !== "cursor") ||
    (query["cursor"] !== undefined &&
      (typeof query["cursor"] !== "string" ||
        !/^[1-9]\d{0,9}$/.test(query["cursor"])))
  )
    throw invalid(
      Object.keys(query).some((key) => key !== "cursor")
        ? ["query"]
        : ["cursor"],
    );
  if (query["cursor"] === undefined) return null;
  const cursor = Number(query["cursor"]);
  if (!Number.isSafeInteger(cursor) || cursor > 2_147_483_647)
    throw invalid(["cursor"]);
  return cursor;
}

/**
 * Orders of the signed-in customer (M4.3/M5.4, ADRs 0018/0023). Read-only history remains available
 * through the customer-account capability; quote and creation require an ACTIVE store.
 */
@ApiTags("customer")
@Controller("customer/stores/:storeSlug/me/orders")
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @Get()
  @CustomerRoute()
  @ApiOperation({
    summary: "List the signed-in customer's orders",
    description:
      "Newest first, 50 per page. Pass nextCursor as cursor. Results include only the authenticated customer's orders in the store from the URL.",
  })
  listCustomer(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.setHeader("Cache-Control", "no-store");
    return this.orders.listForCustomer(parseCustomerOrderCursor(query));
  }

  @Get(":orderId")
  @CustomerRoute()
  @ApiOperation({
    summary: "Read one of the signed-in customer's orders",
    description:
      "Returns the immutable order snapshot and status timeline. A different customer's order is indistinguishable from a missing order.",
  })
  getCustomer(
    @Param("orderId") orderId: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!UUID.test(orderId)) throw invalid(["orderId"]);
    res.setHeader("Cache-Control", "no-store");
    return this.orders.getForCustomer(orderId);
  }

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
  constructor(
    private readonly orders: OrderService,
    private readonly orderHistory: OrderHistoryService,
  ) {}

  @Post(":orderId/incidents")
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @ApiBody({ type: IncidentBody })
  @ApiHeader({
    name: "Idempotency-Key",
    required: true,
    description:
      "A UUID per incident the person records; a retry reuses it with the same body.",
  })
  @ApiOperation({
    summary: "Record an incident on an order",
    description: `201 with the new incident; 200 with the same incident when the key and body repeat (nothing else is written). 409 IDEMPOTENCY_CONFLICT when the key was used for another body on this order. The order's state and values never change. Ended orders accept incidents for ${INCIDENT_WINDOW_DAYS} days (422 INCIDENT_WINDOW_CLOSED after). A suspended store accepts them from the OWNER only (403 TENANT_NOT_ACTIVE).`,
  })
  async reportIncident(
    @Param("orderId") orderId: string,
    @Body() raw: unknown,
    @Headers("idempotency-key") key: string | undefined,
    @Res({ passthrough: true }) res: Response,
    @Headers("x-request-id") requestId?: string,
  ) {
    const result = validateIncident(raw);
    const paths = [
      ...(UUID.test(orderId) ? [] : ["orderId"]),
      ...(typeof key === "string" && UUID.test(key) ? [] : ["Idempotency-Key"]),
      ...(result.ok ? [] : result.paths),
    ];
    if (paths.length || !result.ok) throw invalid(paths);
    const { created, incident } = await this.orderHistory.reportIncident(
      orderId,
      result.value,
      key!.toLowerCase(),
      auditRequestId(requestId),
    );
    res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
    return incident;
  }

  @Post(":orderId/incidents/:incidentId/resolve")
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @HttpCode(HttpStatus.OK)
  @ApiBody({ type: ResolutionBody })
  @ApiOperation({
    summary: "Resolve an open incident",
    description:
      "Once: a resolved incident is 409 INCIDENT_ALREADY_RESOLVED and keeps its first resolution.",
  })
  resolveIncident(
    @Param("orderId") orderId: string,
    @Param("incidentId") incidentId: string,
    @Body() raw: unknown,
    @Headers("x-request-id") requestId?: string,
  ) {
    const ids = [
      ...(UUID.test(orderId) ? [] : ["orderId"]),
      ...(UUID.test(incidentId) ? [] : ["incidentId"]),
    ];
    if (ids.length) throw invalid(ids);
    const result = validateResolution(raw);
    if (!result.ok) throw invalid(result.paths);
    return this.orderHistory.resolveIncident(
      orderId,
      incidentId,
      result.value.resolutionNote,
      auditRequestId(requestId),
    );
  }

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

  // Declared before ":orderId" so "history" is not read as an order id.
  @Get("history")
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @ApiOperation({
    summary: "Search the order history of the active store",
    description: `Newest first, ${ORDER_HISTORY_PAGE_SIZE} per page; pass nextCursor as cursor for the next page. Optional filters: from and to (YYYY-MM-DD, the store's local days of placedAt, both included), status, fulfillment and number. Unknown or malformed filters are 422 VALIDATION_FAILED.`,
  })
  history(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = parseOrderHistoryQuery(query);
    if (!result.ok) throw invalid(result.paths);
    res.setHeader("Cache-Control", "no-store");
    return this.orderHistory.history(result.value);
  }

  @Get(":orderId")
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @ApiOperation({
    summary: "Read an order in the active store",
    description:
      "With its items, every transition with the author's name for staff changes, and its incidents.",
  })
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

@ApiTags("admin")
@Controller("admin/reports")
export class AdminReportController {
  constructor(private readonly history: OrderHistoryService) {}

  @Get("daily")
  @AdminRoute("OWNER")
  @ApiOperation({
    summary: "Daily sales of the active store",
    description: `Count and sum of COMPLETED orders per local day of completion, split by fulfillment and payment method, from and to included (YYYY-MM-DD, at most ${DAILY_REPORT_MAX_DAYS} days). Rejected and canceled orders never count. OWNER only.`,
  })
  daily(
    @Query() query: Record<string, unknown>,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = parseDailyReportQuery(query);
    if (!result.ok) throw invalid(result.paths);
    res.setHeader("Cache-Control", "no-store");
    return this.history.dailyReport(result.value);
  }
}
