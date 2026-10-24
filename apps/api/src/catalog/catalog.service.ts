import { randomUUID } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { TenantTransactions } from "../tenancy/tenant-transaction";
import { currentTenantContext } from "../tenancy/tenant-context";
import { ApiError } from "../errors/api-error";
import { TenantStatusPolicy } from "../tenancy/tenant-status-policy";
import type { TenantStatus } from "../tenancy/tenant.entity";
import type {
  CatalogCategoryBody,
  CatalogFlavorBody,
  CatalogIngredientBody,
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
      const [categories, sizes, ingredients, flavors, prices] =
        await Promise.all([
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
            `select f.id, f.category_id as "categoryId", f.name, f.description, f.available, (f.archived_at is not null) as archived, coalesce(array_agg(fi.ingredient_id) filter (where fi.ingredient_id is not null), '{}') as "ingredientIds" from catalog_flavors f left join catalog_flavor_ingredients fi on fi.tenant_id = f.tenant_id and fi.flavor_id = f.id group by f.id order by f.name`,
          ),
          em.execute(
            `select flavor_id as "flavorId", size_id as "sizeId", price_cents as "priceCents" from catalog_flavor_prices order by flavor_id, size_id`,
          ),
        ]);
      return { categories, sizes, ingredients, flavors, flavorPrices: prices };
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
        sortOrder: "sort_order",
        slices: "slices",
        maxFlavors: "max_flavors",
        available: "available",
        removable: "removable",
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
      };
      for (const key of ["categoryId", "name", "description", "available"])
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
      const availability = ["pizza_sizes", "catalog_flavors"].includes(table)
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
            "catalogWrite",
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
      ].includes(table)
    )
      throw new Error("invalid catalog table");
  }
}
