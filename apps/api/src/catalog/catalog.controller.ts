import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
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
import { CatalogService } from "./catalog.service";

const bodyError = () =>
  new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    "VALIDATION_FAILED",
    "Invalid request body.",
  );

class CategoryBody {
  @ApiProperty() name!: string;
  @ApiProperty({ enum: ["PIZZA", "PRODUCT"] }) kind!: "PIZZA" | "PRODUCT";
  @ApiPropertyOptional() sortOrder?: number;
}
class SizeBody {
  @ApiProperty() name!: string;
  @ApiProperty({ minimum: 1 }) slices!: number;
  @ApiProperty({ enum: [1, 2] }) maxFlavors!: 1 | 2;
  @ApiPropertyOptional() sortOrder?: number;
}
class IngredientBody {
  @ApiProperty() name!: string;
  @ApiPropertyOptional() removable?: boolean;
}
class FlavorBody {
  @ApiProperty({ format: "uuid" }) categoryId!: string;
  @ApiProperty() name!: string;
  @ApiPropertyOptional() description?: string | null;
  @ApiPropertyOptional({ type: [String] }) ingredientIds?: string[];
}
class PriceBody {
  @ApiProperty({ format: "uuid" }) sizeId!: string;
  @ApiProperty({ minimum: 1 }) priceCents!: number;
}

@ApiTags("catalog")
@Controller("admin/catalog")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get("items")
  @AdminRoute("OWNER", "MANAGER")
  @ApiOperation({ summary: "Get the current tenant catalog for management" })
  get() {
    return this.catalog.get();
  }

  @Get("audit-events")
  @AdminRoute("OWNER", "MANAGER")
  @ApiOperation({ summary: "List recent catalog audit events" })
  audit() {
    return this.catalog.listAudit();
  }

  @Post("categories")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: CategoryBody })
  createCategory(@Body() body: unknown, @Req() req: Request) {
    if (
      !isObject(body) ||
      !only(body, ["name", "kind", "sortOrder"]) ||
      !name(body.name) ||
      !["PIZZA", "PRODUCT"].includes(String(body.kind)) ||
      !optionalNonnegativeInteger(body.sortOrder)
    )
      throw bodyError();
    return this.catalog.createCategory(
      body as unknown as CategoryBody,
      requestIdOf(req),
    );
  }

  @Patch("categories/:id")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: CategoryBody })
  updateCategory(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    if (
      !UUID.test(id) ||
      !isObject(body) ||
      Object.keys(body).length === 0 ||
      !only(body, ["name", "sortOrder"]) ||
      ("name" in body && !name(body.name)) ||
      !optionalNonnegativeInteger(body.sortOrder)
    )
      throw bodyError();
    return this.catalog.updateSimple(
      "catalog_categories",
      "category",
      id,
      body,
      requestIdOf(req),
    );
  }
  @Delete("categories/:id")
  @AdminRoute("OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  archiveCategory(@Param("id") id: string, @Req() req: Request) {
    return this.archive("catalog_categories", "category", id, req);
  }

  @Post("sizes")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: SizeBody })
  createSize(@Body() body: unknown, @Req() req: Request) {
    if (
      !isObject(body) ||
      !only(body, ["name", "slices", "maxFlavors", "sortOrder"]) ||
      !name(body.name) ||
      !posInt(body.slices) ||
      ![1, 2].includes(Number(body.maxFlavors)) ||
      !optionalNonnegativeInteger(body.sortOrder)
    )
      throw bodyError();
    return this.catalog.createSize(
      body as unknown as SizeBody,
      requestIdOf(req),
    );
  }
  @Patch("sizes/:id")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: SizeBody })
  updateSize(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const keys = ["name", "slices", "maxFlavors", "sortOrder", "available"];
    if (
      !UUID.test(id) ||
      !isObject(body) ||
      !Object.keys(body).length ||
      !only(body, keys) ||
      ("name" in body && !name(body.name)) ||
      ("slices" in body && !posInt(body.slices)) ||
      ("maxFlavors" in body && ![1, 2].includes(Number(body.maxFlavors))) ||
      !optionalNonnegativeInteger(body.sortOrder) ||
      ("available" in body && typeof body.available !== "boolean")
    )
      throw bodyError();
    return this.catalog.updateSimple(
      "pizza_sizes",
      "size",
      id,
      body,
      requestIdOf(req),
    );
  }
  @Delete("sizes/:id")
  @AdminRoute("OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  archiveSize(@Param("id") id: string, @Req() req: Request) {
    return this.archive("pizza_sizes", "size", id, req);
  }

  @Post("ingredients")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: IngredientBody })
  createIngredient(@Body() body: unknown, @Req() req: Request) {
    if (
      !isObject(body) ||
      !only(body, ["name", "removable"]) ||
      !name(body.name) ||
      ("removable" in body && typeof body.removable !== "boolean")
    )
      throw bodyError();
    return this.catalog.createIngredient(
      body as unknown as IngredientBody,
      requestIdOf(req),
    );
  }
  @Patch("ingredients/:id")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: IngredientBody })
  updateIngredient(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    if (
      !UUID.test(id) ||
      !isObject(body) ||
      !Object.keys(body).length ||
      !only(body, ["name", "removable"]) ||
      ("name" in body && !name(body.name)) ||
      ("removable" in body && typeof body.removable !== "boolean")
    )
      throw bodyError();
    return this.catalog.updateSimple(
      "catalog_ingredients",
      "ingredient",
      id,
      body,
      requestIdOf(req),
    );
  }
  @Delete("ingredients/:id")
  @AdminRoute("OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  archiveIngredient(@Param("id") id: string, @Req() req: Request) {
    return this.archive("catalog_ingredients", "ingredient", id, req);
  }

  @Post("flavors")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: FlavorBody })
  createFlavor(@Body() body: unknown, @Req() req: Request) {
    if (
      !isObject(body) ||
      !only(body, ["categoryId", "name", "description", "ingredientIds"]) ||
      !UUID.test(String(body.categoryId)) ||
      !name(body.name) ||
      !optionalText(body.description, 2000) ||
      !optionalUuidList(body.ingredientIds)
    )
      throw bodyError();
    return this.catalog.createFlavor(
      body as unknown as FlavorBody,
      requestIdOf(req),
    );
  }
  @Patch("flavors/:id")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: FlavorBody })
  updateFlavor(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    if (
      !UUID.test(id) ||
      !isObject(body) ||
      !Object.keys(body).length ||
      !only(body, [
        "categoryId",
        "name",
        "description",
        "ingredientIds",
        "available",
      ]) ||
      ("categoryId" in body && !UUID.test(String(body.categoryId))) ||
      ("name" in body && !name(body.name)) ||
      ("description" in body && !optionalText(body.description, 2000)) ||
      ("ingredientIds" in body && !optionalUuidList(body.ingredientIds)) ||
      ("available" in body && typeof body.available !== "boolean")
    )
      throw bodyError();
    return this.catalog.updateFlavor(id, body, requestIdOf(req));
  }
  @Delete("flavors/:id")
  @AdminRoute("OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  archiveFlavor(@Param("id") id: string, @Req() req: Request) {
    return this.archive("catalog_flavors", "flavor", id, req);
  }

  @Put("flavors/:id/prices/:sizeId")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: PriceBody })
  setFlavorPrice(
    @Param("id") id: string,
    @Param("sizeId") sizeId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    if (
      !UUID.test(id) ||
      !UUID.test(sizeId) ||
      !isObject(body) ||
      !only(body, ["priceCents"]) ||
      !posInt(body.priceCents)
    )
      throw bodyError();
    return this.catalog.setFlavorPrice(
      id,
      sizeId,
      body.priceCents as number,
      requestIdOf(req),
    );
  }

  @Delete("flavors/:id/prices/:sizeId")
  @AdminRoute("OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  removeFlavorPrice(
    @Param("id") id: string,
    @Param("sizeId") sizeId: string,
    @Req() req: Request,
  ) {
    if (!UUID.test(id) || !UUID.test(sizeId)) throw bodyError();
    return this.catalog.removeFlavorPrice(id, sizeId, requestIdOf(req));
  }

  private archive(table: string, entity: string, id: string, req: Request) {
    if (!UUID.test(id)) throw bodyError();
    return this.catalog.archive(table, entity, id, requestIdOf(req));
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const name = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= 120;
const posInt = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) >= 1;
const optionalNonnegativeInteger = (value: unknown) =>
  value === undefined || (Number.isSafeInteger(value) && Number(value) >= 0);
const optionalText = (value: unknown, max: number) =>
  value === undefined ||
  value === null ||
  (typeof value === "string" && value.length <= max);
const optionalUuidList = (value: unknown) =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= 100 &&
    value.every((id) => typeof id === "string" && UUID.test(id)) &&
    new Set(value).size === value.length);
