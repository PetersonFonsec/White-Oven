import { defineConfig } from "@playwright/test";

const ADMIN = "http://127.0.0.1:4310";

/**
 * Panel browser tests against a real API and PostgreSQL (apps/api/test/e2e-server.ts). Needs
 * TEST_DATABASE_OWNER_URL, like the API integration tests. Run with `pnpm test:e2e:admin`.
 */
export default defineConfig({
  testDir: ".",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  outputDir: "../../../test-results/admin",
  use: {
    baseURL: ADMIN,
    browserName: "chromium",
    channel:
      process.env.WHITEOVEN_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined,
    locale: "pt-BR",
    viewport: { width: 1280, height: 860 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @whiteoven/api run e2e-server",
      env: { E2E_API_PORT: "3101", E2E_ADMIN_ORIGIN: ADMIN },
      url: "http://127.0.0.1:3101/health",
      reuseExistingServer: false,
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 120_000,
    },
    {
      command:
        "pnpm --filter @whiteoven/admin exec ng serve --configuration production --host 127.0.0.1 --port 4310 --proxy-config e2e/proxy.e2e.json",
      url: ADMIN,
      reuseExistingServer: false,
      timeout: 180_000,
    },
  ],
});
