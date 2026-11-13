// Only used by Playwright. createTestDatabase owns a uniquely named disposable DB.
import { createTestDatabase } from "../../api/dist/tests/test/postgres.js";
import { insertTenant } from "../../api/dist/tests/test/staff-fixtures.js";
import { seedOrderStore } from "../../api/dist/tests/test/order-fixtures.js";
import { createApp } from "../../api/dist/tests/src/app.js";
import { loadConfig } from "../../api/dist/tests/src/config/config.js";

const database = await createTestDatabase();
let app;
try {
  const owner = await database.connect(database.ownerUrl);
  const tenant = await insertTenant(owner, "forno-teste");
  await seedOrderStore(owner, tenant);
  app = await createApp(
    loadConfig({
      NODE_ENV: "test",
      DATABASE_URL: database.appUrl,
      PLATFORM_DATABASE_URL: database.platformUrl,
      API_LOG_LEVEL: "warn",
    }),
  );
  await app.listen(3102, "127.0.0.1");
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await app.close();
    await database.drop();
    process.exit(0);
  }
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
} catch (error) {
  if (app) await app.close();
  await database.drop();
  throw error;
}
