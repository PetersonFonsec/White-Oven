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

test("staff filter the history, see who moved an order and record and resolve an incident", async ({
  page,
}) => {
  await signIn(page, "equipe@e2e.test");
  await page
    .getByRole("navigation", { name: "Seções da loja" })
    .getByRole("link", { name: "Histórico" })
    .click();
  const rows = page.locator("tbody tr");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toContainText("#3");

  await page.getByLabel("Situação").selectOption("CANCELED");
  await page.getByRole("button", { name: "Filtrar" }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Cancelado");

  await page.getByRole("button", { name: "Limpar" }).click();
  await expect(rows).toHaveCount(3);
  await page
    .getByRole("button", { name: "Detalhes do pedido número 1" })
    .click();
  const detail = page.getByRole("dialog", { name: "Pedido #1" });
  await expect(detail).toContainText("Concluído");
  await expect(detail).toContainText("por Pessoa Teste");
  await expect(detail).toContainText("Nenhuma ocorrência registrada.");

  await detail.getByLabel("Tipo").selectOption("QUALITY");
  await detail.getByLabel("Descrição").fill("Massa crua, cliente ligou.");
  await detail.getByRole("button", { name: "Registrar ocorrência" }).click();
  await expect(detail).toContainText("Massa crua, cliente ligou.");
  await expect(detail).toContainText("Aberta");
  await expect(detail).toContainText("Concluído");

  await detail
    .getByLabel("Como foi resolvida (opcional)")
    .fill("Cupom enviado");
  await detail.getByRole("button", { name: "Marcar como resolvida" }).click();
  await expect(detail).toContainText("Resolvida por Pessoa Teste");
  await expect(detail).toContainText("Cupom enviado");
  await detail.getByRole("button", { name: "Fechar" }).click();
  await expect(rows.nth(2)).not.toContainText("ocorrência");
});

test("an owner sees the daily report with only completed orders", async ({
  page,
}) => {
  await signIn(page, "dona@e2e.test", /Pizzaria pizzaria-centro/);
  await page
    .getByRole("navigation", { name: "Seções da loja" })
    .getByRole("link", { name: "Relatório" })
    .click();
  const totals = page.locator("tfoot tr");
  // One completed order of R$ 45,00; the canceled and the open ones never count.
  await expect(totals.locator("td").first()).toHaveText("1");
  await expect(totals.locator("td").nth(1)).toContainText("45.00");
  await expect(page.locator("caption")).toContainText("America/Sao_Paulo");
});
