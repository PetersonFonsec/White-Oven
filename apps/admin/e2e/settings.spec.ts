import { type Page, expect, test } from "@playwright/test";

const PASSWORD = "senha-e2e-whiteoven";

/** Signs in; `store` picks one when the person belongs to several. */
async function signIn(page: Page, email: string, store?: RegExp) {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  if (store) await page.getByRole("button", { name: store }).click();
  await expect(page).toHaveURL(/\/loja$/);
}

test("an owner saves hours that cross midnight and sees overlaps the API refuses", async ({
  page,
}) => {
  await signIn(page, "dona@e2e.test", /Pizzaria pizzaria-bairro/);
  await page
    .getByRole("navigation", { name: "Seções da loja" })
    .getByRole("link", { name: "Configurações" })
    .click();
  await page.getByRole("tab", { name: "Horários" }).click();

  const day = (name: string) =>
    page.locator("fieldset").filter({
      has: page.locator("legend", { hasText: new RegExp(`^${name}$`) }),
    });
  await day("Sexta").getByRole("button", { name: "Adicionar turno" }).click();
  await day("Sexta").getByLabel("Fecha").fill("02:00");
  await expect(day("Sexta")).toContainText("fecha no dia seguinte");
  await day("Sábado").getByRole("button", { name: "Adicionar turno" }).click();
  await day("Sábado").getByLabel("Abre").fill("01:00");
  await day("Sábado").getByLabel("Fecha").fill("03:00");
  await page.getByRole("button", { name: "Salvar horários" }).click();

  await expect(page.getByRole("alert")).toHaveText(
    "Confira os horários destacados.",
  );
  await expect(day("Sábado").locator(".field-error")).toContainText(
    "madrugada do dia anterior",
  );
  await expect(day("Sábado").getByLabel("Abre")).toHaveAttribute(
    "aria-invalid",
    "true",
  );

  await day("Sábado").getByLabel("Abre").fill("18:00");
  await day("Sábado").getByLabel("Fecha").fill("23:00");
  await page.getByRole("button", { name: "Salvar horários" }).click();
  await expect(page.locator(".settings-notice")).toHaveText("Horários salvos.");

  await page.reload();
  await page.getByRole("tab", { name: "Horários" }).click();
  await expect(day("Sexta").getByLabel("Fecha")).toHaveValue("02:00");

  await page.getByRole("tab", { name: "Pedidos e entrega" }).click();
  await page.getByLabel("Retirada no balcão").check();
  await page.getByLabel("Taxa de entrega (R$)").fill("7,50");
  await page.getByRole("button", { name: "Salvar pedidos e entrega" }).click();
  await expect(page.locator(".field-error")).toContainText(
    "Informe o endereço de retirada",
  );
  await page.getByLabel("Endereço de retirada").fill("Rua das Pizzas, 10");
  await page.getByRole("button", { name: "Salvar pedidos e entrega" }).click();
  await expect(page.locator(".settings-notice")).toHaveText(
    "Configurações de pedidos e entrega salvas.",
  );
  await page.reload();
  await page.getByRole("tab", { name: "Pedidos e entrega" }).click();
  await expect(page.getByLabel("Taxa de entrega (R$)")).toHaveValue("7.50");
});

test("staff pause new orders from the home page and reopen", async ({
  page,
}) => {
  await signIn(page, "equipe@e2e.test");
  await expect(
    page
      .getByRole("navigation", { name: "Seções da loja" })
      .getByRole("link", { name: "Configurações" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Pausar 15 min" }).click();
  await expect(
    page.getByText(/Pedidos pausados até \d{2}:\d{2}/),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText(/Pedidos pausados até \d{2}:\d{2}/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Reabrir agora" }).click();
  await expect(page.getByText("A loja está recebendo pedidos")).toBeVisible();
});
