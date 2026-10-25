import { type Page, expect, test } from "@playwright/test";

const PASSWORD = "senha-e2e-whiteoven";

async function signIn(page: Page, email: string, store: RegExp) {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await page.getByRole("button", { name: store }).click();
  await expect(page).toHaveURL(/\/loja$/);
}

/** A solid PNG drawn by the browser, so the test needs no image files. */
async function png(page: Page, width: number, height: number) {
  const dataUrl = await page.evaluate(
    ([w, h]) => {
      const canvas = document.createElement("canvas");
      canvas.width = w!;
      canvas.height = h!;
      const context = canvas.getContext("2d")!;
      context.fillStyle = "#b3261e";
      context.fillRect(0, 0, w!, h!);
      return canvas.toDataURL("image/png");
    },
    [width, height],
  );
  return Buffer.from(dataUrl.split(",")[1]!, "base64");
}

test("an owner cannot publish an unreadable theme, then publishes a readable one with an icon", async ({
  page,
}) => {
  await signIn(page, "dona@e2e.test", /Pizzaria pizzaria-bairro/);
  await page
    .getByRole("navigation", { name: "Seções da loja" })
    .getByRole("link", { name: "Marca" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Marca", level: 1 }),
  ).toBeVisible();
  await expect(page.getByText("ainda usa as cores padrão")).toBeVisible();

  const publish = page.getByRole("button", { name: "Publicar marca" });
  const text = page.getByRole("textbox", {
    name: "Texto sobre a cor principal",
    exact: true,
  });
  await text.fill("#FFFFFF");
  await expect(
    page.locator('[data-pair="contrast.onPrimary/primary"]'),
  ).toContainText("insuficiente");
  await expect(publish).toBeDisabled();

  await page
    .getByRole("textbox", { name: "Cor principal", exact: true })
    .fill("#B3261E");
  await page
    .getByRole("textbox", { name: "Principal ao passar o cursor", exact: true })
    .fill("#8C1D18");
  await page
    .getByRole("textbox", { name: "Principal pressionada", exact: true })
    .fill("#601410");
  await expect(page.locator(".contrast--fail")).toHaveCount(0);

  // A wide image is not an icon: the API refuses and the panel says why.
  await page.getByLabel("Ícone", { exact: true }).setInputFiles({
    name: "icone.png",
    mimeType: "image/png",
    buffer: await png(page, 800, 300),
  });
  await expect(page.getByText("Imagem enviada.")).toBeVisible();
  await publish.click();
  await expect(page.getByRole("alert")).toContainText("não foi publicada");
  await expect(page.locator("#brand-icon-error")).toContainText("quadrado");

  await page.getByLabel("Ícone", { exact: true }).setInputFiles({
    name: "icone.png",
    mimeType: "image/png",
    buffer: await png(page, 512, 512),
  });
  await expect(page.getByText("Imagem enviada.")).toBeVisible();
  await publish.click();
  await expect(
    page.getByRole("status").filter({ hasText: "Marca publicada" }),
  ).toHaveText("Marca publicada (versão 1).");

  await page.reload();
  await expect(
    page.getByRole("textbox", { name: "Cor principal", exact: true }),
  ).toHaveValue("#B3261E");
  await expect(page.getByAltText("Ícone atual")).toBeVisible();
  await expect(page.getByText("Versão publicada: 1.")).toBeVisible();
});

test("staff do not see the brand editor", async ({ page }) => {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill("equipe@e2e.test");
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page).toHaveURL(/\/loja$/);
  await expect(
    page.getByRole("navigation", { name: "Seções da loja" }).getByRole("link", {
      name: "Marca",
    }),
  ).toHaveCount(0);
  await page.goto("/loja/marca");
  await expect(page).not.toHaveURL(/\/loja\/marca$/);
});
