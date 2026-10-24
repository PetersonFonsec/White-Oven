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
            `select id, name, removable from catalog_ingredients where archived_at is null order by name`,
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
    await this.perform(async (em) => {
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
      await this.audit(
        em,
        "catalog.flavor.created",
        "flavor",
        id,
        { categoryId: body.categoryId },
        requestId,
      );
    });
    return { id };
  }

  async updateSimple(
    table: string,
    entity: string,
    id: string,
    patch: Record<string, unknown>,
    requestId: string,
  ) {
    this.assertTable(table);
    await this.perform(async (em) => {
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
      const changes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(patch)) {
        const column = mapping[key];
        if (!column) continue;
        assignments.push(`${column} = ?`);
        values.push(key === "name" ? (value as string).trim() : value);
        changes[key] = value;
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
      await this.audit(
        em,
        `catalog.${entity}.updated`,
        entity,
        id,
        changes,
        requestId,
      );
    });
    return { id };
  }

  async updateFlavor(
    id: string,
    patch: Record<string, unknown>,
    requestId: string,
  ) {
    await this.perform(async (em) => {
      const before = await this.findOne(em, "catalog_flavors", id);
      if (!before || before.archived_at) throw notFound();
      const assignments: string[] = [];
      const values: unknown[] = [];
      const changes: Record<string, unknown> = {};
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
          changes[key] = value;
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
        changes.ingredientIds = patch.ingredientIds;
      }
      await this.audit(
        em,
        "catalog.flavor.updated",
        "flavor",
        id,
        changes,
        requestId,
      );
    });
    return { id };
  }

  async setFlavorPrice(
    flavorId: string,
    sizeId: string,
    priceCents: number,
    requestId: string,
  ) {
    await this.perform(async (em) => {
      const [flavor] = await em.execute<{ id: string }[]>(
        "select id from catalog_flavors where id = ? and archived_at is null",
        [flavorId],
      );
      const [size] = await em.execute<{ id: string }[]>(
        "select id from pizza_sizes where id = ? and archived_at is null and available = true",
        [sizeId],
      );
      if (!flavor || !size) throw notFound();
      const [old] = await em.execute<{ priceCents: number }[]>(
        'select price_cents as "priceCents" from catalog_flavor_prices where flavor_id = ? and size_id = ? for update',
        [flavorId, sizeId],
      );
      await em.execute(
        `insert into catalog_flavor_prices (tenant_id,flavor_id,size_id,price_cents) values (current_setting('app.tenant_id')::uuid,?,?,?) on conflict (tenant_id,flavor_id,size_id) do update set price_cents=excluded.price_cents,updated_at=now()`,
        [flavorId, sizeId, priceCents],
      );
      await this.audit(
        em,
        old ? "catalog.flavor.price_changed" : "catalog.flavor.price_created",
        "flavor_price",
        flavorId,
        { sizeId, from: old?.priceCents ?? null, to: priceCents },
        requestId,
      );
    });
    return { flavorId, sizeId, priceCents };
  }

  async removeFlavorPrice(flavorId: string, sizeId: string, requestId: string) {
    await this.perform(async (em) => {
      const [row] = await em.execute<{ priceCents: number }[]>(
        `delete from catalog_flavor_prices where flavor_id=? and size_id=? returning price_cents as "priceCents"`,
        [flavorId, sizeId],
      );
      if (!row) throw notFound();
      await this.audit(
        em,
        "catalog.flavor.price_removed",
        "flavor_price",
        flavorId,
        { sizeId, from: row.priceCents, to: null },
        requestId,
      );
    });
  }

  async archive(table: string, entity: string, id: string, requestId: string) {
    this.assertTable(table);
    await this.perform(async (em) => {
      const availability = ["pizza_sizes", "catalog_flavors"].includes(table)
        ? ", available=false"
        : "";
      const [row] = await em.execute<{ id: string; archivedAt: Date | null }[]>(
        `update ${table} set archived_at=now()${availability}, updated_at=now() where id=? and archived_at is null returning id, archived_at as "archivedAt"`,
        [id],
      );
      if (!row) throw notFound();
      if (table === "catalog_categories") {
        const flavors = await em.execute<{ id: string }[]>(
          "update catalog_flavors set archived_at=now(),available=false,updated_at=now() where category_id=? and archived_at is null returning id",
          [id],
        );
        for (const flavor of flavors)
          await this.audit(
            em,
            "catalog.flavor.archived",
            "flavor",
            flavor.id,
            { archived: true, categoryId: id },
            requestId,
          );
      }
      if (table === "catalog_ingredients")
        await em.execute(
          "delete from catalog_flavor_ingredients where ingredient_id=?",
          [id],
        );
      await this.audit(
        em,
        `catalog.${entity}.archived`,
        entity,
        id,
        { archived: true },
        requestId,
      );
    });
  }

  private async create(
    table: string,
    entity: string,
    data: Record<string, unknown>,
    requestId: string,
  ) {
    const id = randomUUID(),
      tenantId = currentTenantContext().tenantId;
    const columns = Object.keys(data);
    const values = Object.values(data);
    await this.perform(async (em) => {
      try {
        await em.execute(
          `insert into ${table} (id,tenant_id,${columns.join(",")}) values (?, ?, ${columns.map(() => "?").join(",")})`,
          [id, tenantId, ...values],
        );
      } catch (error) {
        this.mapConstraint(error);
      }
      await this.audit(
        em,
        `catalog.${entity}.created`,
        entity,
        id,
        data,
        requestId,
      );
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
  private async audit(
    em: import("@mikro-orm/postgresql").EntityManager,
    action: string,
    entity: string,
    id: string,
    changes: Record<string, unknown>,
    requestId: string,
  ) {
    const context = currentTenantContext();
    if (context.actor.type !== "staff")
      throw new Error("catalog writes require a staff actor");
    await em.execute(
      `select whiteoven_catalog_write_audit(?,?,?,?,?::jsonb,?::uuid)`,
      [
        context.actor.staffUserId,
        action,
        entity,
        id,
        JSON.stringify(changes),
        uuid(requestId) ? requestId : null,
      ],
    );
  }
  private async perform<T>(
    work: (em: import("@mikro-orm/postgresql").EntityManager) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.transactions.run(async (em) => {
        const context = currentTenantContext();
        if (context.actor.type !== "staff")
          throw new Error("catalog writes require staff");
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
