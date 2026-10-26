import { Migration } from "@mikro-orm/migrations";
import { tenantIsolationSql } from "../tenant-isolation-sql";

/**
 * M4.3 orders (ADR 0018): the M1.5 `orders` projection grows into the order aggregate, plus its
 * items, the per-store order number and the creation keys (domain-model.md#pedido).
 *
 * - `orders` gains NOT NULL columns without defaults. Before M4.3 nothing created orders (the
 *   projection only existed for the suspension), so no environment has rows; if one had, the
 *   `alter table` fails and changes nothing, instead of inventing values.
 * - Prices, items, address and payment are immutable after creation: the app may update only
 *   the columns that transitions (M4.4) and the account deletion (anonymization) change, and
 *   never updates or deletes items.
 * - `order_creation_keys` keeps the SHA-256 of the `Idempotency-Key` per scope
 *   (`customer:{customerId}`), every column NOT NULL, so a null never escapes the unique key.
 *
 * Forward-only, like every migration here (ADR 0005).
 */
export class Migration20261029000000_orders extends Migration {
  override up(): void {
    this.addSql(`
      alter table orders
        add column number integer not null,
        add column customer_id uuid not null,
        add column customer_name text,
        add column customer_phone text,
        add column fulfillment text not null,
        add column delivery_address jsonb,
        add column payment_method text not null,
        add column change_for_cents integer,
        add column notes text,
        add column items_subtotal_cents integer not null,
        add column delivery_fee_cents integer not null,
        add column discount_cents integer not null default 0,
        add column total_cents integer not null,
        add column anonymized_at timestamptz,
        add constraint orders_number_key unique (tenant_id, number),
        add constraint orders_number_positive check (number > 0),
        add constraint orders_customer_fk foreign key (tenant_id, customer_id)
          references customers (tenant_id, id),
        add constraint orders_fulfillment_valid check (fulfillment in ('DELIVERY', 'PICKUP')),
        add constraint orders_payment_method_valid check (
          payment_method in ('CASH', 'CARD_ON_DELIVERY', 'PIX_ON_DELIVERY')),
        add constraint orders_customer_snapshot check (anonymized_at is not null or (
          customer_name is not null and char_length(btrim(customer_name)) between 1 and 120)),
        add constraint orders_anonymized check (anonymized_at is null or (
          customer_name is null and customer_phone is null and delivery_address is null and notes is null)),
        add constraint orders_delivery_address check (
          anonymized_at is not null or (fulfillment = 'DELIVERY') = (delivery_address is not null)),
        add constraint orders_delivery_address_object check (
          delivery_address is null or jsonb_typeof(delivery_address) = 'object'),
        add constraint orders_money check (
          items_subtotal_cents >= 0 and delivery_fee_cents >= 0 and discount_cents = 0
          and total_cents = items_subtotal_cents + delivery_fee_cents - discount_cents),
        add constraint orders_pickup_without_fee check (fulfillment = 'DELIVERY' or delivery_fee_cents = 0),
        add constraint orders_change_for check (
          change_for_cents is null or (payment_method = 'CASH' and change_for_cents >= total_cents)),
        add constraint orders_notes_length check (notes is null or char_length(notes) between 1 and 280);
      create index orders_customer_idx on orders (tenant_id, customer_id, placed_at desc);

      create table order_items (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        order_id uuid not null,
        position smallint not null,
        kind text not null,
        quantity smallint not null,
        unit_price_cents integer not null,
        total_cents integer not null,
        snapshot jsonb not null,
        constraint order_items_tenant_id_id_key unique (tenant_id, id),
        constraint order_items_position_key unique (tenant_id, order_id, position),
        constraint order_items_order_fk foreign key (tenant_id, order_id) references orders (tenant_id, id),
        constraint order_items_kind_valid check (kind in ('PIZZA', 'PRODUCT')),
        constraint order_items_position_range check (position between 0 and 29),
        constraint order_items_quantity_range check (quantity between 1 and 20),
        constraint order_items_money check (unit_price_cents >= 0 and total_cents = unit_price_cents * quantity),
        constraint order_items_snapshot_object check (jsonb_typeof(snapshot) = 'object')
      );

      create table tenant_order_counters (
        tenant_id uuid primary key references tenants (id),
        last_number integer not null,
        constraint tenant_order_counters_positive check (last_number > 0)
      );

      create table order_creation_keys (
        id uuid primary key default gen_random_uuid(),
        tenant_id uuid not null references tenants (id),
        scope text not null,
        key_hash bytea not null,
        request_hash bytea not null,
        order_id uuid not null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        constraint order_creation_keys_tenant_id_id_key unique (tenant_id, id),
        constraint order_creation_keys_key unique (tenant_id, scope, key_hash),
        constraint order_creation_keys_order_fk foreign key (tenant_id, order_id)
          references orders (tenant_id, id),
        constraint order_creation_keys_scope_format check (scope ~ '^customer:[0-9a-f-]{36}$'),
        constraint order_creation_keys_hash_lengths check (
          octet_length(key_hash) = 32 and octet_length(request_hash) = 32),
        constraint order_creation_keys_expiry check (expires_at > created_at)
      );
    `);
    for (const table of [
      "order_items",
      "tenant_order_counters",
      "order_creation_keys",
    ])
      for (const statement of tenantIsolationSql(table)) this.addSql(statement);
    this.addSql(`
      revoke update on orders from whiteoven_app;
      grant update (status, rejection_reason, updated_at, customer_name, customer_phone,
        delivery_address, notes, anonymized_at) on orders to whiteoven_app;
      revoke update, delete, truncate on order_items from whiteoven_app;
      revoke delete, truncate on tenant_order_counters, order_creation_keys from whiteoven_app;
    `);
  }

  override down(): void {
    throw new Error("Migration20261029000000_orders is forward-only");
  }
}
