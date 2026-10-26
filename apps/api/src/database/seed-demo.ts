import { OWNER_ROLE } from "../config/config";
import { loadMigrationConfig } from "./migrate";
import { hashPassword, passwordProblem } from "../auth/password";
import { createOrm } from "./orm";

/**
 * Creates a repeatable local demo store and one login per store role. Never use in production.
 * Credentials are provided by the developer in WHITEOVEN_DEMO_PASSWORD; no default password is
 * embedded or printed. The first operator remains provisioned through api:create-operator and
 * must enroll MFA through the normal UI flow.
 */
export async function seedDemo(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production")
    throw new Error("demo seed is disabled in production");
  const migrate = loadMigrationConfig(env);
  const ownerUrl = new URL(migrate.ownerUrl);
  if (
    ownerUrl.username !== OWNER_ROLE ||
    !["localhost", "127.0.0.1", "::1"].includes(ownerUrl.hostname)
  )
    throw new Error("demo seed requires a local DATABASE_OWNER_URL");
  const password = env.WHITEOVEN_DEMO_PASSWORD ?? "";
  const issue = passwordProblem(password);
  if (issue) throw new Error(`WHITEOVEN_DEMO_PASSWORD ${issue}`);
  const hash = await hashPassword(password);
  const orm = await createOrm({ url: migrate.ownerUrl, poolMax: 1 });
  try {
    return await orm.em.fork().transactional(async (em) => {
      const [tenant] = await em.execute<{ id: string }[]>(
        `insert into tenants (slug,display_name,status)
         values ('whiteoven-demo','Pizzaria Demonstração','ACTIVE')
         on conflict (slug) do update set display_name=excluded.display_name,status='ACTIVE',updated_at=now()
         returning id`,
      );
      const tenantId = tenant!.id;
      await em.execute("select set_config('app.tenant_id', ?, true)", [
        tenantId,
      ]);
      const profiles = [
        { role: "OWNER", email: "owner@whiteoven.local", name: "Demo Owner" },
        {
          role: "MANAGER",
          email: "manager@whiteoven.local",
          name: "Demo Manager",
        },
        { role: "STAFF", email: "staff@whiteoven.local", name: "Demo Staff" },
      ] as const;
      const profileIds: Record<string, string> = {};
      for (const profile of profiles) {
        const [user] = await em.execute<{ id: string }[]>(
          `insert into staff_users (email,name,password_hash,status)
           values (?,?,?,'ACTIVE') on conflict (email) do update
           set name=excluded.name,password_hash=excluded.password_hash,status='ACTIVE',updated_at=now()
           returning id`,
          [profile.email, profile.name, hash],
        );
        profileIds[profile.role] = user!.id;
        await em.execute(
          `insert into memberships (tenant_id,staff_user_id,role,status) values (?,?,?,'ACTIVE')
           on conflict (tenant_id,staff_user_id) do update set role=excluded.role,status='ACTIVE',updated_at=now()`,
          [tenantId, user!.id, profile.role],
        );
      }
      // Deterministic request identity makes this fixture auditable and repeatable.
      const categoryId = await upsertCategory(em, tenantId);
      await upsertCatalog(em, tenantId, categoryId);
      await em.execute(
        `insert into store_settings (tenant_id,fulfillment_modes,delivery_fee_cents,minimum_order_cents,
         delivery_area_description,estimated_prep_minutes,estimated_delivery_minutes,accept_timeout_minutes,
         accepted_payment_methods,contact_phone,pickup_address)
         values (?,array['DELIVERY','PICKUP'],500,3000,'Bairros centrais',25,45,5,
         array['CASH','CARD_ON_DELIVERY','PIX_ON_DELIVERY'],'+55 11 90000-0000','Rua de Teste, 100')
         on conflict (tenant_id) do nothing`,
        [tenantId],
      );
      await em.execute(
        `insert into store_opening_hours (tenant_id,rules,exceptions) values (?,?::jsonb,'[]'::jsonb)
         on conflict (tenant_id) do nothing`,
        [
          tenantId,
          JSON.stringify(
            Array.from({ length: 7 }, (_, weekday) => ({
              weekday,
              intervals: [{ opensAt: "00:00", closesAt: "23:59" }],
            })),
          ),
        ],
      );
      await em.execute(
        `insert into store_pauses (tenant_id,paused_until) values (?,null) on conflict (tenant_id) do nothing`,
        [tenantId],
      );
      await em.execute(
        `insert into brand_themes (tenant_id) values (?) on conflict (tenant_id) do nothing`,
        [tenantId],
      );
      // Retain deterministic synthetic provenance for local inspection; no PII or secret values.
      return {
        slug: "whiteoven-demo",
        tenantId,
        profiles: profiles.map(({ role, email }) => ({ role, email })),
      };
    });
  } finally {
    await orm.close();
  }
}

async function upsertCategory(
  em: { execute: <T = unknown>(sql: string, params?: unknown[]) => Promise<T> },
  tenantId: string,
) {
  const [row] = await em.execute<{ id: string }[]>(
    `insert into catalog_categories (tenant_id,name,kind,sort_order) values (?,'Pizzas','PIZZA',0)
     on conflict (tenant_id,lower(name)) where archived_at is null do update set name=excluded.name returning id`,
    [tenantId],
  );
  return row!.id;
}

async function upsertCatalog(
  em: { execute: <T = unknown>(sql: string, params?: unknown[]) => Promise<T> },
  tenantId: string,
  categoryId: string,
) {
  const [size] = await em.execute<{ id: string }[]>(
    `insert into pizza_sizes (tenant_id,name,slices,max_flavors,sort_order) values (?,'Grande',8,2,0)
     on conflict (tenant_id,lower(name)) where archived_at is null do update set available=true returning id`,
    [tenantId],
  );
  const [flavor] = await em.execute<{ id: string }[]>(
    `insert into catalog_flavors (tenant_id,category_id,name,description) values (?,?,'Margherita','Molho, mozzarella e manjericão')
     on conflict (tenant_id,category_id,lower(name)) where archived_at is null do update set available=true returning id`,
    [tenantId, categoryId],
  );
  await em.execute(
    `insert into catalog_flavor_prices (tenant_id,flavor_id,size_id,price_cents) values (?,?,?,4990) on conflict (tenant_id,flavor_id,size_id) do update set price_cents=excluded.price_cents`,
    [tenantId, flavor!.id, size!.id],
  );
  await em.execute(
    `insert into catalog_pricing_policies (tenant_id,half_and_half_strategy,half_and_half_surcharge_cents,max_extras_per_half) values (?,'HIGHEST',0,3) on conflict (tenant_id) do nothing`,
    [tenantId],
  );
}

if (require.main === module) {
  seedDemo().then(
    (result) => {
      process.stdout.write(`Demo store ready: ${result.slug}\n`);
      for (const profile of result.profiles)
        process.stdout.write(`${profile.role}: ${profile.email}\n`);
      process.stdout.write(
        "Password: value supplied in WHITEOVEN_DEMO_PASSWORD\n",
      );
    },
    (error: unknown) => {
      process.stderr.write(
        `demo seed failed: ${error instanceof Error ? error.message : "unknown error"}\n`,
      );
      process.exitCode = 1;
    },
  );
}
