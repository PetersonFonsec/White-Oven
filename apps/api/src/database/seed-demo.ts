import { OWNER_ROLE } from "../config/config";
import { hashPassword, passwordProblem } from "../auth/password";
import { loadMigrationConfig } from "./migrate";
import { createOrm } from "./orm";

const SEED_KEY = "whiteoven-admin-demo-v1";
const DEMO_TENANT = "whiteoven-demo";
const DEMO_PROFILES = [
  { role: "OWNER", email: "owner@whiteoven.local", name: "Demo Owner" },
  { role: "MANAGER", email: "manager@whiteoven.local", name: "Demo Manager" },
  { role: "STAFF", email: "staff@whiteoven.local", name: "Demo Staff" },
] as const;
interface SeedManifest {
  tenantId: string;
  records: Record<string, string>;
  tenantStatus: string;
  profiles: Array<{ role: string; email: string; status: string }>;
}

export class DemoSeedConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DemoSeedConflictError";
  }
}

/**
 * Creates demo records on a clean local database. Once committed, the protected manifest is the
 * proof of provenance. Re-runs are read-only: they never replace passwords, change roles, reset
 * store status, or undo manual edits. A missing manifest plus matching slug/e-mails is a conflict.
 */
export async function seedDemo(env: NodeJS.ProcessEnv = process.env) {
  if (env.NODE_ENV === "production")
    throw new Error("demo seed is disabled in production");
  const migration = loadMigrationConfig(env);
  const ownerUrl = new URL(migration.ownerUrl);
  if (
    ownerUrl.username !== OWNER_ROLE ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(ownerUrl.hostname)
  )
    throw new Error(
      "demo seed requires a local whiteoven_owner DATABASE_OWNER_URL",
    );
  const password = env.WHITEOVEN_DEMO_PASSWORD ?? "";
  const issue = passwordProblem(password);
  if (issue) throw new Error(`WHITEOVEN_DEMO_PASSWORD ${issue}`);

  const orm = await createOrm({ url: migration.ownerUrl, poolMax: 1 });
  try {
    return await orm.em.fork().transactional(async (em) => {
      const [provenance] = await em.execute<
        Array<Pick<SeedManifest, "tenantId" | "records">>
      >(
        'select demo_tenant_id as "tenantId", records from demo_seed_manifest where seed_key=?',
        [SEED_KEY],
      );
      if (provenance) {
        await em.execute("select set_config('app.tenant_id', ?, true)", [
          provenance.tenantId,
        ]);
        const [tenant] = await em.execute<{ status: string }[]>(
          "select status from tenants where id=? and slug=?",
          [provenance.tenantId, DEMO_TENANT],
        );
        if (!tenant)
          throw new DemoSeedConflictError(
            "demo tenant is missing or does not match its provenance manifest",
          );
        await assertManifestRecordsExist(
          em,
          provenance.tenantId,
          provenance.records,
        );
        const profiles = await em.execute<SeedManifest["profiles"]>(
          `select m.role, u.email, u.status
             from memberships m join staff_users u on u.id=m.staff_user_id
            where m.tenant_id=? and m.id::text in
              (select jsonb_array_elements_text(?::jsonb))
            order by array_position(array['OWNER','MANAGER','STAFF'],m.role)`,
          [
            provenance.tenantId,
            JSON.stringify([
              provenance.records["membership:OWNER"],
              provenance.records["membership:MANAGER"],
              provenance.records["membership:STAFF"],
            ]),
          ],
        );
        return {
          slug: DEMO_TENANT,
          tenantId: provenance.tenantId,
          tenantStatus: tenant.status,
          profiles,
          created: false,
        };
      }

      const [tenantConflict] = await em.execute<{ id: string }[]>(
        "select id from tenants where slug=? limit 1",
        [DEMO_TENANT],
      );
      if (tenantConflict)
        throw new DemoSeedConflictError(
          `tenant ${DEMO_TENANT} already exists without demo seed provenance; no data was changed`,
        );
      for (const profile of DEMO_PROFILES) {
        const [userConflict] = await em.execute<{ id: string }[]>(
          "select id from staff_users where email=? limit 1",
          [profile.email],
        );
        if (userConflict)
          throw new DemoSeedConflictError(
            `demo identity ${profile.email} already exists without demo seed provenance; no data was changed`,
          );
      }

      const passwordHash = await hashPassword(password);
      const [tenant] = await em.execute<{ id: string }[]>(
        `insert into tenants (slug,display_name,status)
         values (?, 'Pizzaria Demonstração', 'ACTIVE') returning id`,
        [DEMO_TENANT],
      );
      const tenantId = tenant!.id;
      await em.execute("select set_config('app.tenant_id', ?, true)", [
        tenantId,
      ]);

      const records: Record<string, string> = { tenant: tenantId };
      for (const profile of DEMO_PROFILES) {
        const [user] = await em.execute<{ id: string }[]>(
          `insert into staff_users (email,name,password_hash,status)
           values (?,?,?,'ACTIVE') returning id`,
          [profile.email, profile.name, passwordHash],
        );
        records[`user:${profile.role}`] = user!.id;
        const [membership] = await em.execute<{ id: string }[]>(
          `insert into memberships (tenant_id,staff_user_id,role,status)
           values (?,?,?,'ACTIVE') returning id`,
          [tenantId, user!.id, profile.role],
        );
        records[`membership:${profile.role}`] = membership!.id;
      }

      const [category] = await em.execute<{ id: string }[]>(
        `insert into catalog_categories (tenant_id,name,kind,sort_order)
         values (?,'Pizzas','PIZZA',0) returning id`,
        [tenantId],
      );
      records.category = category!.id;
      const [size] = await em.execute<{ id: string }[]>(
        `insert into pizza_sizes (tenant_id,name,slices,max_flavors,sort_order)
         values (?,'Grande',8,2,0) returning id`,
        [tenantId],
      );
      records.size = size!.id;
      const [flavor] = await em.execute<{ id: string }[]>(
        `insert into catalog_flavors (tenant_id,category_id,name,description)
         values (?,?,'Margherita','Molho, mozzarella e manjericão') returning id`,
        [tenantId, category!.id],
      );
      records.flavor = flavor!.id;
      const [price] = await em.execute<{ id: string }[]>(
        `insert into catalog_flavor_prices (tenant_id,flavor_id,size_id,price_cents)
         values (?,?,?,4990) returning id`,
        [tenantId, flavor!.id, size!.id],
      );
      records.price = price!.id;
      await em.execute(
        `insert into catalog_pricing_policies
          (tenant_id,half_and_half_strategy,half_and_half_surcharge_cents,max_extras_per_half)
         values (?,'HIGHEST',0,3)`,
        [tenantId],
      );
      records.pricingPolicy = tenantId;
      await em.execute(
        `insert into store_settings
          (tenant_id,fulfillment_modes,delivery_fee_cents,minimum_order_cents,delivery_area_description,
           estimated_prep_minutes,estimated_delivery_minutes,accept_timeout_minutes,accepted_payment_methods,
           contact_phone,pickup_address)
         values (?,array['DELIVERY','PICKUP'],500,3000,'Bairros centrais',25,45,5,
           array['CASH','CARD_ON_DELIVERY','PIX_ON_DELIVERY'],'+55 11 90000-0000','Rua de Teste, 100')`,
        [tenantId],
      );
      records.settings = tenantId;
      const rules = Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        intervals: [{ opensAt: "00:00", closesAt: "23:59" }],
      }));
      await em.execute(
        `insert into store_opening_hours (tenant_id,rules,exceptions)
         values (?,?::jsonb,'[]'::jsonb)`,
        [tenantId, JSON.stringify(rules)],
      );
      records.openingHours = tenantId;
      await em.execute(
        "insert into store_pauses (tenant_id,paused_until) values (?,null)",
        [tenantId],
      );
      records.pause = tenantId;
      await em.execute("insert into brand_themes (tenant_id) values (?)", [
        tenantId,
      ]);
      records.brandTheme = tenantId;
      await em.execute(
        "insert into demo_seed_manifest (seed_key,demo_tenant_id,records) values (?,?,?::jsonb)",
        [SEED_KEY, tenantId, JSON.stringify(records)],
      );
      return {
        slug: DEMO_TENANT,
        tenantId,
        tenantStatus: "ACTIVE",
        profiles: DEMO_PROFILES.map(({ role, email }) => ({
          role,
          email,
          status: "ACTIVE",
        })),
        created: true,
      };
    });
  } finally {
    await orm.close();
  }
}

async function assertManifestRecordsExist(
  em: { execute: <T = unknown>(sql: string, params?: unknown[]) => Promise<T> },
  tenantId: string,
  records: Record<string, string>,
) {
  const tables: Record<string, string> = {
    category: "catalog_categories",
    size: "pizza_sizes",
    flavor: "catalog_flavors",
    price: "catalog_flavor_prices",
  };
  for (const [key, table] of Object.entries(tables)) {
    const [row] = await em.execute<{ id: string }[]>(
      `select id from ${table} where tenant_id=? and id=?`,
      [tenantId, records[key]],
    );
    if (!row)
      throw new DemoSeedConflictError(
        `demo record ${key} is missing; seed left all remaining data unchanged`,
      );
  }
  for (const role of ["OWNER", "MANAGER", "STAFF"]) {
    const [user] = await em.execute<{ id: string }[]>(
      "select id from staff_users where id=?",
      [records[`user:${role}`]],
    );
    const [membership] = await em.execute<{ id: string }[]>(
      "select id from memberships where tenant_id=? and id=? and staff_user_id=?",
      [tenantId, records[`membership:${role}`], records[`user:${role}`]],
    );
    if (!user || !membership)
      throw new DemoSeedConflictError(
        `demo ${role} records are incomplete; seed left all remaining data unchanged`,
      );
  }
  for (const [key, table] of [
    ["pricingPolicy", "catalog_pricing_policies"],
    ["settings", "store_settings"],
    ["openingHours", "store_opening_hours"],
    ["pause", "store_pauses"],
    ["brandTheme", "brand_themes"],
  ] as const) {
    const [row] = await em.execute<{ tenant_id: string }[]>(
      `select tenant_id from ${table} where tenant_id=?`,
      [records[key]],
    );
    if (!row)
      throw new DemoSeedConflictError(
        `demo record ${key} is missing; seed left all remaining data unchanged`,
      );
  }
}

if (require.main === module) {
  seedDemo().then(
    (result) => {
      const action = result.created ? "created" : "already exists; preserved";
      process.stdout.write(
        `Demo store ${action}: ${result.slug} (${result.tenantStatus})\n`,
      );
      for (const profile of result.profiles)
        process.stdout.write(
          `${profile.role}: ${profile.email} (${profile.status})\n`,
        );
      process.stdout.write(
        "Passwords are supplied through WHITEOVEN_DEMO_PASSWORD.\n",
      );
    },
    (error: unknown) => {
      const message =
        error instanceof DemoSeedConflictError
          ? error.message
          : error instanceof Error
            ? error.message.replace(
                /postgres(?:ql)?:\/\/[^\s]+/gi,
                "[database URL]",
              )
            : "unknown error";
      process.stderr.write(`demo seed failed: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
