import type { EntityManager, MikroORM } from "@mikro-orm/postgresql";
import { runInTenant } from "../src/tenancy/tenant-transaction";

/** Ids of the orderable store `seedOrderStore` creates. */
export interface OrderStore {
  size: string;
  smallSize: string;
  calabresa: string;
  marguerita: string;
  paused: string;
  tomato: string;
  crust: string;
  extra: string;
  soda: string;
  juice: string;
}

/** The whole local day, in two shifts that touch at noon and midnight without overlapping. */
export const ALL_DAY = [0, 1, 2, 3, 4, 5, 6].flatMap((weekday) => [
  { weekday, opensAt: "00:00", closesAt: "12:00" },
  { weekday, opensAt: "12:00", closesAt: "00:00" },
]);

/**
 * A store open all day that delivers (fee R$ 7,00) and does pickup, with a minimum of R$ 30,00:
 * Grande (2 flavors) and Broto (1); Calabresa R$ 40,00 and Marguerita R$ 50,00 (with removable
 * tomato) in Grande, Calabresa R$ 25,00 in Broto; an unavailable flavor; Catupiry crust R$ 8,00;
 * Azeitona R$ 6,00 / R$ 3,00 per half; soda R$ 8,00 and an unavailable juice. Half-and-half
 * charges the highest flavor plus R$ 2,00, at most 3 extras per half. Pays in CASH or Pix.
 */
export function seedOrderStore(
  owner: MikroORM,
  tenantId: string,
): Promise<OrderStore> {
  return runInTenant(owner, tenantId, async (em: EntityManager) => {
    const id = async (query: string, params: unknown[] = []) => {
      const [row] = await em.execute<{ id: string }[]>(query, [
        tenantId,
        ...params,
      ]);
      return row!.id;
    };
    const pizzas = await id(
      "insert into catalog_categories (tenant_id,name,kind) values (?,'Pizzas','PIZZA') returning id",
    );
    const drinks = await id(
      "insert into catalog_categories (tenant_id,name,kind) values (?,'Bebidas','PRODUCT') returning id",
    );
    const size = await id(
      "insert into pizza_sizes (tenant_id,name,slices,max_flavors) values (?,'Grande',8,2) returning id",
    );
    const smallSize = await id(
      "insert into pizza_sizes (tenant_id,name,slices,max_flavors) values (?,'Broto',4,1) returning id",
    );
    const tomato = await id(
      "insert into catalog_ingredients (tenant_id,name,removable) values (?,'Tomate',true) returning id",
    );
    const flavor = (name: string, available = true) =>
      id(
        "insert into catalog_flavors (tenant_id,category_id,name,available) values (?,?,?,?) returning id",
        [pizzas, name, available],
      );
    const calabresa = await flavor("Calabresa");
    const marguerita = await flavor("Marguerita");
    const paused = await flavor("Sazonal", false);
    await id(
      "insert into catalog_flavor_ingredients (tenant_id,flavor_id,ingredient_id) values (?,?,?) returning flavor_id as id",
      [marguerita, tomato],
    );
    for (const [flavorId, sizeId, cents] of [
      [calabresa, size, 4000],
      [marguerita, size, 5000],
      [paused, size, 4500],
      [calabresa, smallSize, 2500],
    ] as const)
      await id(
        "insert into catalog_flavor_prices (tenant_id,flavor_id,size_id,price_cents) values (?,?,?,?) returning id",
        [flavorId, sizeId, cents],
      );
    const crust = await id(
      "insert into catalog_crusts (tenant_id,name) values (?,'Catupiry') returning id",
    );
    await id(
      "insert into catalog_crust_prices (tenant_id,crust_id,size_id,price_cents) values (?,?,?,800) returning id",
      [crust, size],
    );
    const extra = await id(
      "insert into catalog_extras (tenant_id,name) values (?,'Azeitona') returning id",
    );
    await id(
      "insert into catalog_extra_prices (tenant_id,extra_id,size_id,whole_price_cents,half_price_cents) values (?,?,?,600,300) returning id",
      [extra, size],
    );
    const soda = await id(
      "insert into catalog_simple_products (tenant_id,category_id,name,price_cents) values (?,?,'Refrigerante',800) returning id",
      [drinks],
    );
    const juice = await id(
      "insert into catalog_simple_products (tenant_id,category_id,name,price_cents,available) values (?,?,'Suco',900,false) returning id",
      [drinks],
    );
    await id(
      "insert into catalog_pricing_policies (tenant_id,half_and_half_strategy,half_and_half_surcharge_cents,max_extras_per_half) values (?,'HIGHEST',200,3) returning tenant_id as id",
    );
    await id(
      `insert into store_settings (tenant_id, fulfillment_modes, delivery_fee_cents, minimum_order_cents,
         estimated_prep_minutes, estimated_delivery_minutes, accept_timeout_minutes,
         accepted_payment_methods, pickup_address)
       values (?, '{DELIVERY,PICKUP}', 700, 3000, 30, 30, 10, '{CASH,PIX_ON_DELIVERY}', 'Rua da Loja, 1')
       returning tenant_id as id`,
    );
    await id(
      "insert into store_opening_hours (tenant_id, rules, exceptions) values (?, ?::jsonb, '[]') returning tenant_id as id",
      [JSON.stringify(ALL_DAY)],
    );
    return {
      size,
      smallSize,
      calabresa,
      marguerita,
      paused,
      tomato,
      crust,
      extra,
      soda,
      juice,
    };
  });
}

/**
 * A placed pickup order of a new customer, written directly as the owner: for tests that need an
 * order to exist (suspension, isolation) without going through the API.
 */
export function insertOrder(
  owner: MikroORM,
  tenantId: string,
): Promise<{ id: string; customerId: string }> {
  return runInTenant(owner, tenantId, async (em) => {
    const [customer] = await em.execute<{ id: string }[]>(
      `insert into customers (tenant_id, name, email, password_hash, privacy_policy_version, accepted_at)
       values (?, 'Cliente Pedido', 'pedido-' || gen_random_uuid() || '@teste.invalid',
               '$argon2id$fixture', '2026-10', now())
       returning id`,
      [tenantId],
    );
    const [order] = await em.execute<{ id: string }[]>(
      `insert into orders (tenant_id, number, customer_id, customer_name, fulfillment,
         payment_method, items_subtotal_cents, delivery_fee_cents, total_cents)
       values (?, coalesce((select max(number) from orders), 0) + 1, ?, 'Cliente Pedido', 'PICKUP',
               'CASH', 4000, 0, 4000)
       returning id`,
      [tenantId, customer!.id],
    );
    return { id: order!.id, customerId: customer!.id };
  });
}
