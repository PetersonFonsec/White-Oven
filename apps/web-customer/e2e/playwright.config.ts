import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  outputDir: "../../../test-results/web-customer",
  use: {
    baseURL: "http://127.0.0.1:4320",
    browserName: "chromium",
    channel:
      process.env.WHITEOVEN_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined,
    locale: "pt-BR",
    actionTimeout: 12000,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "tablet", use: { viewport: { width: 768, height: 1024 } } },
    { name: "mobile", use: { viewport: { width: 390, height: 844 } } },
  ],
  webServer: [
    ...(process.env.TEST_DATABASE_OWNER_URL
      ? [
          {
            command:
              "pnpm --filter @whiteoven/api exec tsc -p tsconfig.test.json && node test-api.mjs",
            url: "http://127.0.0.1:3102/health",
            reuseExistingServer: false,
            timeout: 120000,
            gracefulShutdown: { signal: "SIGTERM" as const, timeout: 10000 },
          },
        ]
      : []),
    {
      command:
        "pnpm --filter @whiteoven/web-customer exec ng serve --host 127.0.0.1 --port 4320 --proxy-config e2e/proxy.json",
      url: "http://127.0.0.1:4320",
      reuseExistingServer: false,
      timeout: 120000,
    },
  ],
});
