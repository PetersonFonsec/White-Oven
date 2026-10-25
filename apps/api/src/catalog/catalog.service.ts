import { randomUUID } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { TenantTransactions } from "../tenancy/tenant-transaction";
import { currentTenantContext } from "../tenancy/tenant-context";
import { ApiError } from "../errors/api-error";
import { TenantStatusPolicy } from "../tenancy/tenant-status-policy";
import type { TenantStatus } from "../tenancy/tenant.entity";
import type { TenantCapability } from "../tenancy/tenant-status-policy";
import type {
  CatalogCategoryBody,
  CatalogFlavorBody,
  CatalogIngredientBody,
  CatalogNamedItemBody,
  CatalogPricingPolicyBody,
  CatalogSimpleProductBody,
  CatalogSizeBody,
} from "./catalog.types";

const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const conflict = () =>
  new ApiError(
    HttpStatus.CONFLICT,
    "RESOURCE_CONFLICT",
    "The requested catalog resource conflicts with existing data.",
  );
const notFound = () =>
  new ApiError(
    HttpStatus.NOT_FOUND,
    "CATALOG_RESOURCE_NOT_FOUND",
    "Catalog resource not found.",
  );

@Injectable()
export class CatalogService {
  constructor(
    @Inject(MikroORM) private readonly orm: MikroORM,
    private readonly transactions: TenantTransactions,
  ) {}

  get() {
    return this.transactions.run(async (em) => {
      const [
        categories,
        sizes,
        ingredients,
        flavors,
        prices,
        crusts,
        crustPrices,
        extras,
        extraPrices,
        simpleProducts,
        pricingPolicy,
      ] = await Promise.all([
        em.execute(
          `select id, name, kind, sort_order as "sortOrder", (archived_at is not null) as archived from catalog_categories order by sort_order, name`,
        ),
        em.execute(
          `select id, name, slices, max_flavors as "maxFlavors", sort_order as "sortOrder", available, (archived_at is not null) as archived from pizza_sizes order by sort_order, slices`,
        ),
        em.execute(
          `select id, name, removable, (archived_at is not null) as archived from catalog_ingredients order by name`,
        ),
        em.execute(
          `select f.id, f.category_id as "categoryId", f.image_asset_id as "imageId", f.name, f.description, f.available, (f.archived_at is not null) as archived, coalesce(array_agg(fi.ingredient_id) filter (where fi.ingredient_id is not null), '{}') as "ingredientIds" from catalog_flavors f left join catalog_flavor_ingredients fi on fi.tenant_id = f.tenant_id and fi.flavor_id = f.id group by f.id order by f.name`,
        ),
        em.execute(
          `select flavor_id as "flavorId", size_id as "sizeId", price_cents as "priceCents" from catalog_flavor_prices order by flavor_id, size_id`,
        ),
        em.execute(
          `select id,name,available,(archived_at is not null) as archived from catalog_crusts order by name`,
        ),
        em.execute(
          `select crust_id as "crustId",size_id as "sizeId",price_cents as "priceCents" from catalog_crust_prices order by crust_id,size_id`,
        ),
        em.execute(
          `select id,name,available,(archived_at is not null) as archived from catalog_extras order by name`,
        ),
        em.execute(
          `select extra_id as "extraId",size_id as "sizeId",whole_price_cents as "wholePriceCents",half_price_cents as "halfPriceCents" from catalog_extra_prices order by extra_id,size_id`,
        ),
        em.execute(
          `select id,category_id as "categoryId",image_asset_id as "imageId",name,price_cents as "priceCents",available,(archived_at is not null) as archived from catalog_simple_products order by name`,
        ),
        em.execute(
          `select half_and_half_strategy as "halfAndHalfStrategy",half_and_half_surcharge_cents as "halfAndHalfSurchargeCents",max_extras_per_half as "maxExtrasPerHalf" from catalog_pricing_policies limit 1`,
        ),
      ]);
      return {
        categories,
        sizes,
        ingredients,
        flavors,
        flavorPrices: prices,
        crusts,
        crustPrices,
        extras,
        extraPrices,
        simpleProducts,
        pricingPolicy: pricingPolicy[0] ?? null,
      };
    });
  }

  listAudit() {
    const context = currentTenantContext();
    if (context.actor.type !== "staff")
      throw new Error("catalog audit requires a staff actor");
    const actor = context.actor;
    return this.transactions.run((em) =>
      em.execute(
        `select id, action, entity_type as "entityType", entity_id as "entityId", changes, request_id as "requestId", at from whiteoven_catalog_read_audit(?,?,?)`,
        [actor.staffUserId, actor.sessionId, context.tenantId],
      ),
    );
  }

  async createCategory(body: CatalogCategoryBody, requestId: string) {
    return this.create(
      "catalog_categories",
      "category",
      {
        name: body.name.trim(),
        kind: body.kind,
        sort_order: body.sortOrder ?? 0,
      },
      requestId,
    );
  }
  async createSize(body: CatalogSizeBody, requestId: string) {
    return this.create(
      "pizza_sizes",
      "size",
      {
        name: body.name.trim(),
        slices: body.slices,
        max_flavors: body.maxFlavors,
        sort_order: body.sortOrder ?? 0,
      },
      requestId,
    );
  }
  async createIngredient(body: CatalogIngredientBody, requestId: string) {
    return this.create(
      "catalog_ingredients",
      "ingredient",
      { name: body.name.trim(), removable: body.removable ?? true },
      requestId,
    );
  }
  async createCrust(body: CatalogNamedItemBody, requestId: string) {
    return this.create(
      "catalog_crusts",
      "crust",
      { name: body.name.trim() },
      requestId,
    );
  }
  async createExtra(body: CatalogNamedItemBody, requestId: string) {
    return this.create(
      "catalog_extras",
      "extra",
      { name: body.name.trim() },
      requestId,
    );
  }
  async createSimpleProduct(body: CatalogSimpleProductBody, requestId: string) {
    const tenantId = currentTenantContext().tenantId;
    const id = randomUUID();
    await this.perform(requestId, async (em) => {
      const [category] = await em.execute<
        { kind: string; archivedAt: Date | null }[]
      >(
        'select kind,archived_at as "archivedAt" from catalog_categories where id=?',
        [body.categoryId],
      );
      if (!category || category.kind !== "PRODUCT" || category.archivedAt)
        throw notFound();
      try {
        await em.execute(
          "insert into catalog_simple_products (id,tenant_id,category_id,name,price_cents) values (?,?,?,?,?)",
          [id, tenantId, body.categoryId, body.name.trim(), body.priceCents],
        );
      } catch (error) {
        this.mapConstraint(error);
      }
    });
    return { id };
  }

  async setCrustPrice(
    crustId: string,
    sizeId: string,
    priceCents: number,
    requestId: string,
  ) {
    return this.setAddonPrice(
      "crust",
      crustId,
      sizeId,
      { priceCents },
      requestId,
    );
  }
  async setExtraPrice(
    extraId: string,
    sizeId: string,
    wholePriceCents: number,
    halfPriceCents: number,
    requestId: string,
  ) {
    return this.setAddonPrice(
      "extra",
      extraId,
      sizeId,
      { wholePriceCents, halfPriceCents },
      requestId,
    );
  }
  async removeCrustPrice(crustId: string, sizeId: string, requestId: string) {
    return this.removeAddonPrice("crust", crustId, sizeId, requestId);
  }
  async removeExtraPrice(extraId: string, sizeId: string, requestId: string) {
    return this.removeAddonPrice("extra", extraId, sizeId, requestId);
  }

  async updateAvailability(
    table: string,
    id: string,
    available: boolean,
    requestId: string,
  ) {
    if (
      ![
        "catalog_flavors",
        "catalog_crusts",
        "catalog_extras",
        "catalog_simple_products",
      ].includes(table)
    )
      throw new Error("invalid availability table");
    const actor = currentTenantContext().actor;
    if (actor.type === "staff" && actor.role === "STAFF" && available)
      throw new ApiError(
        HttpStatus.FORBIDDEN,
        "ROLE_FORBIDDEN",
        "Staff can mark an item unavailable only.",
      );
    await this.perform(
      requestId,
      async (em) => {
        const [row] = await em.execute<{ id: string }[]>(
          `update ${table} set available=?,updated_at=now() where id=? and archived_at is null returning id`,
          [available, id],
        );
        if (!row) throw notFound();
      },
      "catalogAvailability",
    );
    return { id, available };
  }

  async updatePricingPolicy(
    policy: CatalogPricingPolicyBody,
    requestId: string,
  ) {
    await this.perform(
      requestId,
      async (em) => {
        await em.execute(
          `insert into catalog_pricing_policies (tenant_id,half_and_half_strategy,half_and_half_surcharge_cents,max_extras_per_half)
         values (current_setting('app.tenant_id')::uuid,?,?,?) on conflict (tenant_id) do update set
         half_and_half_strategy=excluded.half_and_half_strategy,
         half_and_half_surcharge_cents=excluded.half_and_half_surcharge_cents,
         max_extras_per_half=excluded.max_extras_per_half,updated_at=now()`,
          [
            policy.halfAndHalfStrategy,
            policy.halfAndHalfSurchargeCents,
            policy.maxExtrasPerHalf,
          ],
        );
      },
      "catalogPolicyWrite",
    );
    return policy;
  }
  async createFlavor(body: CatalogFlavorBody, requestId: string) {
    const tenantId = currentTenantContext().tenantId;
    const id = randomUUID();
    await this.perform(requestId, async (em) => {
      const [category] = await em.execute<
        { kind: string; archivedAt: Date | null }[]
      >(
        'select kind, archived_at as "archivedAt" from catalog_categories where id = ?',
        [body.categoryId],
      );
      if (!category || category.kind !== "PIZZA" || category.archivedAt)
        throw notFound();
      try {
        await em.execute(
          "insert into catalog_flavors (id, tenant_id, category_id, name, description) values (?, ?, ?, ?, ?)",
          [
            id,
            tenantId,
            body.categoryId,
            body.name.trim(),
            body.description?.trim() || null,
          ],
        );
      } catch (error) {
        this.mapConstraint(error);
      }
      await this.replaceFlavorIngredients(em, id, body.ingredientIds ?? []);
    });
    return { id };
  }

  async updateSimple(
    table: string,
    _entity: string,
    id: string,
    patch: Record<string, unknown>,
    requestId: string,
  ) {
    this.assertTable(table);
    await this.perform(requestId, async (em) => {
      const before = await this.findOne(em, table, id);
      if (!before || before.archived_at) throw notFound();
      const mapping: Record<string, string> = {
        name: "name",
        categoryId: "category_id",
        sortOrder: "sort_order",
        slices: "slices",
        maxFlavors: "max_flavors",
        available: "available",
        removable: "removable",
        priceCents: "price_cents",
        imageId: "image_asset_id",
      };
      const assignments: string[] = [];
      const values: unknown[] = [];
      for (const [key, value] of Object.entries(patch)) {
        const column = mapping[key];
        if (!column) continue;
        assignments.push(`${column} = ?`);
        values.push(key === "name" ? (value as string).trim() : value);
      }
      if (!assignments.length) throw notFound();
      if (table === "catalog_simple_products" && "categoryId" in patch) {
        const [category] = await em.execute<
          { kind: string; archivedAt: Date | null }[]
        >(
          'select kind,archived_at as "archivedAt" from catalog_categories where id=?',
          [patch.categoryId],
        );
        if (!category || category.kind !== "PRODUCT" || category.archivedAt)
          throw notFound();
      }
      assignments.push("updated_at = now()");
      values.push(id);
      try {
        await em.execute(
          `update ${table} set ${assignments.join(", ")} where id = ?`,
          values,
        );
      } catch (error) {
        this.mapConstraint(error);
      }
    });
    return { id };
  }

  async updateFlavor(
    id: string,
    patch: Record<string, unknown>,
    requestId: string,
  ) {
    await this.perform(requestId, async (em) => {
      const before = await this.findOne(em, "catalog_flavors", id);
      if (!before || before.archived_at) throw notFound();
      const assignments: string[] = [];
      const values: unknown[] = [];
      const map: Record<string, string> = {
        categoryId: "category_id",
        name: "name",
        description: "description",
        available: "available",
        imageId: "image_asset_id",
      };
      for (const key of [
        "categoryId",
        "name",
        "description",
        "available",
        "imageId",
      ])
        if (Object.hasOwn(patch, key)) {
          const value = patch[key];
          assignments.push(`${map[key]} = ?`);
          values.push(key === "name" ? (value as string).trim() : value);
        }
      if ("categoryId" in patch) {
        const [row] = await em.execute<
          { kind: string; archivedAt: Date | null }[]
        >(
          'select kind, archived_at as "archivedAt" from catalog_categories where id = ?',
          [patch.categoryId],
        );
        if (!row || row.kind !== "PIZZA" || row.archivedAt) throw notFound();
      }
      if (assignments.length) {
        assignments.push("updated_at = now()");
        values.push(id);
        try {
          await em.execute(
            `update catalog_flavors set ${assignments.join(", ")} where id = ?`,
            values,
          );
        } catch (error) {
          this.mapConstraint(error);
        }
      }
      if ("ingredientIds" in patch) {
        await this.replaceFlavorIngredients(
          em,
          id,
          patch.ingredientIds as string[],
        );
      }
    });
    return { id };
  }

  async setFlavorPrice(
    flavorId: string,
    sizeId: string,
    priceCents: number,
    requestId: string,
  ) {
    await this.perform(requestId, async (em) => {
      const [flavor] = await em.execute<{ id: string }[]>(
        "select id from catalog_flavors where id = ? and archived_at is null",
        [flavorId],
      );
      const [size] = await em.execute<{ id: string }[]>(
        "select id from pizza_sizes where id = ? and archived_at is null and available = true",
        [sizeId],
      );
      if (!flavor || !size) throw notFound();
      await this.lockFlavorPrice(em, flavorId, sizeId);
      await em.execute(
        `insert into catalog_flavor_prices (tenant_id,flavor_id,size_id,price_cents) values (current_setting('app.tenant_id')::uuid,?,?,?) on conflict (tenant_id,flavor_id,size_id) do update set price_cents=excluded.price_cents,updated_at=now()`,
        [flavorId, sizeId, priceCents],
      );
    });
    return { flavorId, sizeId, priceCents };
  }

  async removeFlavorPrice(flavorId: string, sizeId: string, requestId: string) {
    await this.perform(requestId, async (em) => {
      await this.lockFlavorPrice(em, flavorId, sizeId);
      const [row] = await em.execute<{ priceCents: number }[]>(
        `delete from catalog_flavor_prices where flavor_id=? and size_id=? returning price_cents as "priceCents"`,
        [flavorId, sizeId],
      );
      if (!row) throw notFound();
    });
  }

  async archive(table: string, _entity: string, id: string, requestId: string) {
    this.assertTable(table);
    await this.perform(requestId, async (em) => {
      const availability = [
        "pizza_sizes",
        "catalog_flavors",
        "catalog_crusts",
        "catalog_extras",
        "catalog_simple_products",
      ].includes(table)
        ? ", available=false"
        : "";
      const [row] = await em.execute<{ id: string; archivedAt: Date | null }[]>(
        `update ${table} set archived_at=now()${availability}, updated_at=now() where id=? and archived_at is null returning id, archived_at as "archivedAt"`,
        [id],
      );
      if (!row) throw notFound();
      if (table === "catalog_categories") {
        await em.execute(
          "update catalog_flavors set archived_at=now(),available=false,updated_at=now() where category_id=? and archived_at is null",
          [id],
        );
        await em.execute(
          "update catalog_simple_products set archived_at=now(),available=false,updated_at=now() where category_id=? and archived_at is null",
          [id],
        );
      }
    });
  }

  private async create(
    table: string,
    _entity: string,
    data: Record<string, unknown>,
    requestId: string,
  ) {
    const id = randomUUID(),
      tenantId = currentTenantContext().tenantId;
    const columns = Object.keys(data);
    const values = Object.values(data);
    await this.perform(requestId, async (em) => {
      try {
        await em.execute(
          `insert into ${table} (id,tenant_id,${columns.join(",")}) values (?, ?, ${columns.map(() => "?").join(",")})`,
          [id, tenantId, ...values],
        );
      } catch (error) {
        this.mapConstraint(error);
      }
    });
    return { id };
  }
  private async replaceFlavorIngredients(
    em: import("@mikro-orm/postgresql").EntityManager,
    id: string,
    ids: string[],
  ) {
    await em.execute(
      "delete from catalog_flavor_ingredients where flavor_id=?",
      [id],
    );
    for (const ingredientId of ids)
      await em.execute(
        "insert into catalog_flavor_ingredients (tenant_id,flavor_id,ingredient_id) values (current_setting('app.tenant_id')::uuid,?,?)",
        [id, ingredientId],
      );
  }
  private async findOne(
    em: import("@mikro-orm/postgresql").EntityManager,
    table: string,
    id: string,
  ) {
    const [row] = await em.execute<{ id: string; archived_at: Date | null }[]>(
      `select id,archived_at from ${table} where id=? for update`,
      [id],
    );
    return row;
  }
  private async perform<T>(
    requestId: string,
    work: (em: import("@mikro-orm/postgresql").EntityManager) => Promise<T>,
    capability: TenantCapability = "catalogWrite",
  ): Promise<T> {
    try {
      return await this.transactions.run(async (em) => {
        const context = currentTenantContext();
        if (context.actor.type !== "staff")
          throw new Error("catalog writes require staff");
        await em.execute(
          "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true), set_config('app.catalog_request_id', ?, true)",
          [
            context.actor.staffUserId,
            context.actor.sessionId,
            uuid(requestId) ? requestId : "",
          ],
        );
        const [tenant] = await em.execute<{ status: TenantStatus }[]>(
          "select status from tenants where id = ?",
          [context.tenantId],
        );
        if (
          !tenant ||
          !TenantStatusPolicy.allows(
            tenant.status,
            context.actor.role,
            capability,
          )
        ) {
          throw new ApiError(
            HttpStatus.FORBIDDEN,
            "CATALOG_WRITE_FORBIDDEN",
            "Catalog is read-only for this store status.",
          );
        }
        return work(em);
      });
    } catch (error) {
      this.mapConstraint(error);
      throw error;
    }
  }
  private async lockFlavorPrice(
    em: import("@mikro-orm/postgresql").EntityManager,
    flavorId: string,
    sizeId: string,
  ) {
    await em.execute(
      "select pg_advisory_xact_lock(hashtextextended(?::text, 0))",
      [`${flavorId}:${sizeId}`],
    );
  }
  private async setAddonPrice(
    kind: "crust" | "extra",
    ownerId: string,
    sizeId: string,
    values:
      | { priceCents: number }
      | { wholePriceCents: number; halfPriceCents: number },
    requestId: string,
  ) {
    const table =
      kind === "crust" ? "catalog_crust_prices" : "catalog_extra_prices";
    const ownerTable = kind === "crust" ? "catalog_crusts" : "catalog_extras";
    const ownerColumn = kind === "crust" ? "crust_id" : "extra_id";
    const key = kind === "crust" ? "crustId" : "extraId";
    const columns =
      kind === "crust"
        ? ["price_cents"]
        : ["whole_price_cents", "half_price_cents"];
    const input =
      kind === "crust"
        ? [(values as { priceCents: number }).priceCents]
        : [
            (values as { wholePriceCents: number }).wholePriceCents,
            (values as { halfPriceCents: number }).halfPriceCents,
          ];
    await this.perform(requestId, async (em) => {
      const [owner] = await em.execute<{ id: string }[]>(
        `select id from ${ownerTable} where id=? and archived_at is null`,
        [ownerId],
      );
      const [size] = await em.execute<{ id: string }[]>(
        "select id from pizza_sizes where id=? and archived_at is null and available=true",
        [sizeId],
      );
      if (!owner || !size) throw notFound();
      await this.lockAddonPrice(em, kind, ownerId, sizeId);
      const insertColumns = [ownerColumn, "size_id", ...columns];
      const insertValues = input.map(() => `?`).join(",");
      const updateSet = columns
        .map((column) => `${column}=excluded.${column}`)
        .join(",");
      await em.execute(
        `insert into ${table} (tenant_id,${insertColumns.join(",")}) values (current_setting('app.tenant_id')::uuid,?,?,${insertValues})
         on conflict (tenant_id,${ownerColumn},size_id) do update set ${updateSet},updated_at=now()`,
        [ownerId, sizeId, ...input],
      );
    });
    return { [key]: ownerId, sizeId, ...values };
  }
  private async removeAddonPrice(
    kind: "crust" | "extra",
    ownerId: string,
    sizeId: string,
    requestId: string,
  ) {
    const table =
      kind === "crust" ? "catalog_crust_prices" : "catalog_extra_prices";
    const ownerColumn = kind === "crust" ? "crust_id" : "extra_id";
    await this.perform(requestId, async (em) => {
      await this.lockAddonPrice(em, kind, ownerId, sizeId);
      const [row] = await em.execute(
        `delete from ${table} where ${ownerColumn}=? and size_id=? returning id`,
        [ownerId, sizeId],
      );
      if (!row) throw notFound();
    });
  }
  private async lockAddonPrice(
    em: import("@mikro-orm/postgresql").EntityManager,
    kind: string,
    ownerId: string,
    sizeId: string,
  ) {
    await em.execute(
      "select pg_advisory_xact_lock(hashtextextended(?::text, 0))",
      [`${kind}:${ownerId}:${sizeId}`],
    );
  }
  private mapConstraint(error: unknown): never {
    const code = (error as { code?: string } | null)?.code;
    if (code === "23505" || code === "23503" || code === "23514")
      throw conflict();
    throw error;
  }
  private assertTable(table: string) {
    if (
      ![
        "catalog_categories",
        "pizza_sizes",
        "catalog_ingredients",
        "catalog_flavors",
        "catalog_crusts",
        "catalog_extras",
        "catalog_simple_products",
      ].includes(table)
    )
      throw new Error("invalid catalog table");
  }
}
