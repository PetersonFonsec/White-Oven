import { createApp } from "../src/app";
import { loadConfig } from "../src/config/config";
import { runInTenant } from "../src/tenancy/tenant-transaction";
import { createTestDatabase } from "./postgres";
import {
  insertMembership,
  insertStaffUser,
  insertTenant,
} from "./staff-fixtures";

/**
 * API for the panel's browser tests (apps/admin/e2e): a throwaway database with synthetic stores
 * and staff, served on `E2E_API_PORT` with `E2E_ADMIN_ORIGIN` allowed for the refresh cookie.
 * Needs TEST_DATABASE_OWNER_URL; the database is dropped when the process is stopped.
 */
export const E2E_PASSWORD = "senha-e2e-whiteoven";

async function main(): Promise<void> {
  const port = Number(process.env.E2E_API_PORT ?? "3101");
  const origin = process.env.E2E_ADMIN_ORIGIN ?? "http://127.0.0.1:4310";
  const database = await createTestDatabase();
  const owner = await database.connect(database.ownerUrl);
  const centro = await insertTenant(owner, "pizzaria-centro");
  const bairro = await insertTenant(owner, "pizzaria-bairro");
  const dona = await insertStaffUser(owner, "dona@e2e.test", E2E_PASSWORD);
  await insertMembership(owner, centro, dona, "OWNER");
  await insertMembership(owner, bairro, dona, "OWNER");
  const equipe = await insertStaffUser(owner, "equipe@e2e.test", E2E_PASSWORD);
  await insertMembership(owner, centro, equipe, "STAFF");
  const operador = await insertStaffUser(
    owner,
    "operador@e2e.test",
    E2E_PASSWORD,
  );
  await owner.em
    .getConnection()
    .execute("update staff_users set platform_role = 'OPERATOR' where id = ?", [
      operador,
    ]);

  // Orders of pizzaria-centro for the history and the daily report (M4.6): one completed now,
  // one canceled and one in preparation, with the history the API would have written.
  await runInTenant(owner, centro, async (em) => {
    const [customer] = await em.execute<{ id: string }[]>(
      `insert into customers (tenant_id, name, email, password_hash, privacy_policy_version, accepted_at)
       values (?, 'Cliente E2E', 'cliente@e2e.test', '$argon2id$fixture', '2026-10', now()) returning id`,
      [centro],
    );
    for (const [number, status, fulfillment, payment, total, reason] of [
      [1, "COMPLETED", "PICKUP", "CASH", 4500, null],
      [2, "CANCELED", "DELIVERY", "PIX_ON_DELIVERY", 5200, "ITEM_UNAVAILABLE"],
      [3, "PREPARING", "PICKUP", "CARD_ON_DELIVERY", 3800, null],
    ] as const) {
      const fee = fulfillment === "DELIVERY" ? 700 : 0;
      const [order] = await em.execute<{ id: string }[]>(
        `insert into orders (tenant_id, number, customer_id, customer_name, fulfillment,
           delivery_address, payment_method, items_subtotal_cents, delivery_fee_cents,
           total_cents, status, placed_at)
         values (?, ?, ?, 'Cliente E2E', ?, ?::jsonb, ?, ?, ?, ?, ?, now() - interval '1 hour')
         returning id`,
        [
          centro,
          number,
          customer!.id,
          fulfillment,
          fulfillment === "DELIVERY"
            ? JSON.stringify({ street: "Rua E2E", number: "1" })
            : null,
          payment,
          total - fee,
          fee,
          total,
          status,
        ],
      );
      await em.execute(
        `insert into order_status_changes (tenant_id, order_id, from_status, to_status,
           actor_type, actor_id, reason_code)
         values (?, ?, 'PLACED', ?, 'STAFF', ?, ?)`,
        [centro, order!.id, status, equipe, reason],
      );
    }
  });

  const app = await createApp(
    loadConfig({
      NODE_ENV: "test",
      API_LOG_LEVEL: "warn",
      DATABASE_URL: database.appUrl,
      API_ADMIN_ORIGINS: origin,
    }),
  );
  await app.listen(port, "127.0.0.1");
  process.stdout.write(`e2e API ready on http://127.0.0.1:${port}\n`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
    await database.drop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
