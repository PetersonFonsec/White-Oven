import { createApp } from "../src/app";
import { loadConfig } from "../src/config/config";
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
