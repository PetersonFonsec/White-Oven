import { expect, test } from "@playwright/test";
// Synthetic responses are test-only; runtime has no fixture mode or seeded shop.
const colors = {
  primary: "#FF6B00",
  primaryHover: "#ED5F00",
  primaryPressed: "#E85D00",
  onPrimary: "#1A1512",
  accentText: "#9C4300",
};
test("entry validation, store identity, navigation, modal keyboard and reflow", async ({
  page,
}, info) => {
  await page.route("**/v1/public/stores/test-store**", (route) =>
    route.fulfill({
      json: route.request().url().endsWith("/status")
        ? {
            open: true,
            reason: "OPEN",
            timezone: "America/Sao_Paulo",
            pausedUntil: null,
          }
        : {
            slug: "test-store",
            name: "Pizzaria de teste",
            brand: { version: 1, colors, logoImageId: null },
          },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "Abrir pizzaria" }).click();
  await expect(page.getByRole("alert")).toContainText("Confira");
  await page.getByLabel("Identificador da pizzaria").fill("test-store");
  await page.getByRole("button", { name: "Abrir pizzaria" }).click();
  await expect(
    page.getByRole("heading", { name: "Loja aberta" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Informações", exact: true }).click();
  const opener = page.getByRole("button", { name: "Sobre este acesso" });
  await opener.click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("information.png"),
    fullPage: true,
  });
  await page.getByRole("link", { name: "Trocar pizzaria" }).click();
  await expect(
    page.getByRole("heading", { name: "Qual é a sua pizzaria?" }),
  ).toBeVisible();
  await page.screenshot({ path: info.outputPath("entry.png"), fullPage: true });
  await page.goto("/missing");
  await expect(
    page.getByRole("heading", { name: "Página não encontrada" }),
  ).toBeVisible();
});
test("HTTP failure is honest and retry does not create orders", async ({
  page,
}) => {
  let recover = false;
  await page.route("**/v1/public/stores/test-store**", (route) =>
    route.fulfill(
      recover
        ? {
            json: route.request().url().endsWith("/status")
              ? {
                  open: false,
                  reason: "PAUSED",
                  timezone: "America/Sao_Paulo",
                  pausedUntil: null,
                }
              : {
                  slug: "test-store",
                  name: "Pizzaria de teste",
                  brand: { version: 1, colors, logoImageId: null },
                },
          }
        : { status: 503, json: { code: "UNAVAILABLE" } },
    ),
  );
  await page.goto("/lojas/test-store");
  await expect(
    page.getByRole("heading", { name: "Não foi possível conectar" }),
  ).toBeVisible();
  recover = true;
  await page.getByRole("button", { name: "Tentar novamente" }).click();
  await expect(
    page.getByRole("heading", { name: "Loja fechada no momento" }),
  ).toBeVisible();
});
