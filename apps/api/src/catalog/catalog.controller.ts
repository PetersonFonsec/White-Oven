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
class FlavorPatchBody extends FlavorBody {
  @ApiPropertyOptional({ format: "uuid", nullable: true }) imageId?: string | null;
}
class PriceBody {
  @ApiProperty({ format: "uuid" }) sizeId!: string;
  @ApiProperty({ minimum: 1 }) priceCents!: number;
}
class AddonPriceBody {
  @ApiProperty({ minimum: 0 }) priceCents!: number;
}
class ExtraPriceBody {
  @ApiProperty({ minimum: 0 }) wholePriceCents!: number;
  @ApiProperty({ minimum: 0 }) halfPriceCents!: number;
}
class SimpleProductBody {
  @ApiProperty({ format: "uuid" }) categoryId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ minimum: 0 }) priceCents!: number;
}
class CatalogAvailabilityBody {
  @ApiProperty() available!: boolean;
}
class CatalogNamedItemBody {
  @ApiProperty() name!: string;
}
class CatalogNamedItemPatchBody {
  @ApiPropertyOptional() name?: string;
  @ApiPropertyOptional() available?: boolean;
}
class SimpleProductPatchBody {
  @ApiPropertyOptional({ format: "uuid" }) categoryId?: string;
  @ApiPropertyOptional() name?: string;
  @ApiPropertyOptional({ minimum: 0 }) priceCents?: number;
  @ApiPropertyOptional() available?: boolean;
  @ApiPropertyOptional({ format: "uuid", nullable: true }) imageId?: string | null;
}
class PricingPolicyBody {
  @ApiProperty({ enum: ["HIGHEST", "AVERAGE"] })
  halfAndHalfStrategy!: "HIGHEST" | "AVERAGE";
  @ApiProperty({ minimum: 0 }) halfAndHalfSurchargeCents!: number;
  @ApiProperty({ minimum: 0, maximum: 10 }) maxExtrasPerHalf!: number;
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
  @ApiBody({ type: FlavorPatchBody })
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
        "imageId",
      ]) ||
      ("categoryId" in body && !UUID.test(String(body.categoryId))) ||
      ("name" in body && !name(body.name)) ||
      ("description" in body && !optionalText(body.description, 2000)) ||
      ("ingredientIds" in body && !optionalUuidList(body.ingredientIds)) ||
      ("imageId" in body && body.imageId !== null && !UUID.test(String(body.imageId))) ||
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

  @Post("crusts")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: CatalogNamedItemBody })
  createCrust(@Body() body: unknown, @Req() req: Request) {
    if (!isObject(body) || !only(body, ["name"]) || !name(body.name))
      throw bodyError();
    return this.catalog.createCrust(body as { name: string }, requestIdOf(req));
  }
  @Patch("crusts/:id")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: CatalogNamedItemPatchBody })
  updateCrust(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    if (
      !UUID.test(id) ||
      !isObject(body) ||
      !Object.keys(body).length ||
      !only(body, ["name", "available"]) ||
      ("name" in body && !name(body.name)) ||
      ("available" in body && typeof body.available !== "boolean")
    )
      throw bodyError();
    return this.catalog.updateSimple(
      "catalog_crusts",
      "crust",
      id,
      body,
      requestIdOf(req),
    );
  }
  @Delete("crusts/:id")
  @AdminRoute("OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  archiveCrust(@Param("id") id: string, @Req() req: Request) {
    return this.archive("catalog_crusts", "crust", id, req);
  }
  @Put("crusts/:id/prices/:sizeId")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: AddonPriceBody })
  setCrustPrice(
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
      !nonnegativeInt(body.priceCents)
    )
      throw bodyError();
    return this.catalog.setCrustPrice(
      id,
      sizeId,
      body.priceCents as number,
      requestIdOf(req),
    );
  }
  @Delete("crusts/:id/prices/:sizeId")
  @AdminRoute("OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  removeCrustPrice(
    @Param("id") id: string,
    @Param("sizeId") sizeId: string,
    @Req() req: Request,
  ) {
    if (!UUID.test(id) || !UUID.test(sizeId)) throw bodyError();
    return this.catalog.removeCrustPrice(id, sizeId, requestIdOf(req));
  }

  @Post("extras")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: CatalogNamedItemBody })
  createExtra(@Body() body: unknown, @Req() req: Request) {
    if (!isObject(body) || !only(body, ["name"]) || !name(body.name))
      throw bodyError();
    return this.catalog.createExtra(body as { name: string }, requestIdOf(req));
  }
  @Patch("extras/:id")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: CatalogNamedItemPatchBody })
  updateExtra(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    if (
      !UUID.test(id) ||
      !isObject(body) ||
      !Object.keys(body).length ||
      !only(body, ["name", "available"]) ||
      ("name" in body && !name(body.name)) ||
      ("available" in body && typeof body.available !== "boolean")
    )
      throw bodyError();
    return this.catalog.updateSimple(
      "catalog_extras",
      "extra",
      id,
      body,
      requestIdOf(req),
    );
  }
  @Delete("extras/:id")
  @AdminRoute("OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  archiveExtra(@Param("id") id: string, @Req() req: Request) {
    return this.archive("catalog_extras", "extra", id, req);
  }
  @Put("extras/:id/prices/:sizeId")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: ExtraPriceBody })
  setExtraPrice(
    @Param("id") id: string,
    @Param("sizeId") sizeId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    if (
      !UUID.test(id) ||
      !UUID.test(sizeId) ||
      !isObject(body) ||
      !only(body, ["wholePriceCents", "halfPriceCents"]) ||
      !nonnegativeInt(body.wholePriceCents) ||
      !nonnegativeInt(body.halfPriceCents) ||
      Number(body.halfPriceCents) > Number(body.wholePriceCents) ||
      Number(body.wholePriceCents) > 2 * Number(body.halfPriceCents)
    )
      throw bodyError();
    return this.catalog.setExtraPrice(
      id,
      sizeId,
      body.wholePriceCents as number,
      body.halfPriceCents as number,
      requestIdOf(req),
    );
  }
  @Delete("extras/:id/prices/:sizeId")
  @AdminRoute("OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  removeExtraPrice(
    @Param("id") id: string,
    @Param("sizeId") sizeId: string,
    @Req() req: Request,
  ) {
    if (!UUID.test(id) || !UUID.test(sizeId)) throw bodyError();
    return this.catalog.removeExtraPrice(id, sizeId, requestIdOf(req));
  }

  @Post("products")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: SimpleProductBody })
  createProduct(@Body() body: unknown, @Req() req: Request) {
    if (
      !isObject(body) ||
      !only(body, ["categoryId", "name", "priceCents"]) ||
      !UUID.test(String(body.categoryId)) ||
      !name(body.name) ||
      !nonnegativeInt(body.priceCents)
    )
      throw bodyError();
    return this.catalog.createSimpleProduct(
      body as { categoryId: string; name: string; priceCents: number },
      requestIdOf(req),
    );
  }
  @Patch("products/:id")
  @AdminRoute("OWNER", "MANAGER")
  @ApiBody({ type: SimpleProductPatchBody })
  updateProduct(
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    if (
      !UUID.test(id) ||
      !isObject(body) ||
      !Object.keys(body).length ||
      !only(body, ["categoryId", "name", "priceCents", "available", "imageId"]) ||
      ("categoryId" in body && !UUID.test(String(body.categoryId))) ||
      ("name" in body && !name(body.name)) ||
      ("priceCents" in body && !nonnegativeInt(body.priceCents)) ||
      ("imageId" in body && body.imageId !== null && !UUID.test(String(body.imageId))) ||
      ("available" in body && typeof body.available !== "boolean")
    )
      throw bodyError();
    return this.catalog.updateSimple(
      "catalog_simple_products",
      "product",
      id,
      body,
      requestIdOf(req),
    );
  }
  @Delete("products/:id")
  @AdminRoute("OWNER", "MANAGER")
  @HttpCode(HttpStatus.NO_CONTENT)
  archiveProduct(@Param("id") id: string, @Req() req: Request) {
    return this.archive("catalog_simple_products", "product", id, req);
  }

  @Patch("availability/:itemType/:id")
  @AdminRoute("OWNER", "MANAGER", "STAFF")
  @ApiBody({ type: CatalogAvailabilityBody })
  updateAvailability(
    @Param("itemType") itemType: string,
    @Param("id") id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ) {
    const tables: Record<string, string> = {
      flavors: "catalog_flavors",
      crusts: "catalog_crusts",
      extras: "catalog_extras",
      products: "catalog_simple_products",
    };
    if (
      !UUID.test(id) ||
      !tables[itemType] ||
      !isObject(body) ||
      !only(body, ["available"]) ||
      typeof body.available !== "boolean"
    )
      throw bodyError();
    return this.catalog.updateAvailability(
      tables[itemType]!,
      id,
      body.available,
      requestIdOf(req),
    );
  }

  @Put("pricing-policy")
  @AdminRoute("OWNER")
  @ApiBody({ type: PricingPolicyBody })
  updatePricingPolicy(@Body() body: unknown, @Req() req: Request) {
    if (!pricingPolicy(body)) throw bodyError();
    return this.catalog.updatePricingPolicy(body, requestIdOf(req));
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
const nonnegativeInt = (value: unknown) =>
  Number.isSafeInteger(value) &&
  Number(value) >= 0 &&
  Number(value) <= 2_147_483_647;
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
const pricingPolicy = (
  value: unknown,
): value is {
  halfAndHalfStrategy: "HIGHEST" | "AVERAGE";
  halfAndHalfSurchargeCents: number;
  maxExtrasPerHalf: number;
} =>
  isObject(value) &&
  only(value, [
    "halfAndHalfStrategy",
    "halfAndHalfSurchargeCents",
    "maxExtrasPerHalf",
  ]) &&
  ["HIGHEST", "AVERAGE"].includes(String(value.halfAndHalfStrategy)) &&
  nonnegativeInt(value.halfAndHalfSurchargeCents) &&
  Number.isSafeInteger(value.maxExtrasPerHalf) &&
  Number(value.maxExtrasPerHalf) >= 0 &&
  Number(value.maxExtrasPerHalf) <= 10;
