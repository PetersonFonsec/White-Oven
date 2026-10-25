import { type Page, expect, test } from "@playwright/test";

const PASSWORD = "senha-e2e-whiteoven";

async function openMenu(page: Page) {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill("dona@e2e.test");
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.getByRole("button", { name: /Pizzaria pizzaria-bairro/ }).click();
  await page
    .getByRole("navigation", { name: "Seções da loja" })
    .getByRole("link", { name: "Cardápio" })
    .click();
  await expect(page.getByRole("heading", { name: "Cardápio" })).toBeVisible();
}

test("an owner builds a menu: prices are validated, drafts survive saves and the preview prices halves", async ({
  page,
}) => {
  await openMenu(page);
  const notice = page.locator(".menu-notice");
  const tab = (name: string) => page.getByRole("tab", { name }).click();

  await page.locator('[name="newCategoryName"]').fill("Pizzas");
  await page.getByRole("button", { name: "Adicionar categoria" }).click();
  await expect(notice).toHaveText("Categoria adicionada.");

  await tab("Tamanhos");
  await page.locator('[name="newSizeName"]').fill("Grande");
  await page.getByRole("button", { name: "Adicionar tamanho" }).click();
  await expect(notice).toHaveText("Tamanho adicionado.");

  await tab("Sabores");
  for (const name of ["Calabresa", "Margherita"]) {
    await page.locator('[name="newFlavorCategory"]').selectOption("Pizzas");
    await page.locator('[name="newFlavorName"]').fill(name);
    await page.getByRole("button", { name: "Adicionar sabor" }).click();
    await expect(notice).toContainText("Sabor adicionado.");
  }
  const card = (name: string) =>
    page
      .locator("article.catalog-card")
      .filter({ has: page.getByLabel(`Imagem de ${name}`) });
  const calabresa = card("Calabresa");
  const margherita = card("Margherita");

  // An invalid price is explained next to the field and never sent; Enter submits.
  const calabresaPrice = calabresa.getByLabel("Grande", { exact: true });
  await calabresaPrice.fill("0");
  await calabresaPrice.press("Enter");
  await expect(calabresaPrice).toHaveAttribute("aria-invalid", "true");
  await expect(calabresa.locator(".field-error")).toHaveText(
    "O preço do sabor deve ser maior que zero.",
  );
  await calabresaPrice.fill("50");
  await calabresaPrice.press("Enter");
  await expect(notice).toHaveText("Preço atualizado.");
  await expect(calabresaPrice).toHaveValue("50.00");
  await expect(calabresa.locator(".field-error")).toHaveCount(0);

  // Saving one flavor reloads the catalog without losing what was typed in another.
  await calabresa.getByLabel("Nome").fill("Calabresa da casa");
  await expect(calabresa.getByText("Não salvo")).toBeVisible();
  const margheritaPrice = margherita.getByLabel("Grande", { exact: true });
  await margheritaPrice.fill("60,5");
  await margheritaPrice.press("Enter");
  await expect(notice).toHaveText("Preço atualizado.");
  await expect(margheritaPrice).toHaveValue("60.50");
  await expect(calabresa.getByLabel("Nome")).toHaveValue("Calabresa da casa");
  await expect(calabresa.getByText("Não salvo")).toBeVisible();

  await page.getByRole("button", { name: "Atualizar" }).click();
  await expect(notice).toContainText("1 alteração não salva foi mantida");
  await expect(calabresa.getByLabel("Nome")).toHaveValue("Calabresa da casa");

  await tab("Prévia de preço");
  const result = page.locator(".preview-result strong");
  await expect(result).toContainText(/50[.,]00/);
  await page.locator('[name="previewMode"]').selectOption("HALVES");
  await page.locator('[name="previewFlavorRight"]').selectOption("Margherita");
  await expect(result).toContainText(/60[.,]50/);
});
