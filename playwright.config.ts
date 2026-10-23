import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./apps/landing/tests/e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:4323",
    browserName: "chromium",
    channel:
      process.env.WHITEOVEN_BROWSER_CHANNEL === "chrome" ? "chrome" : undefined,
    locale: "pt-BR",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 960 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 375, height: 812 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command:
      "pnpm --filter @whiteoven/landing exec astro preview --host 127.0.0.1 --port 4323",
    url: "http://127.0.0.1:4323",
    reuseExistingServer: false,
  },
});
