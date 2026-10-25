import { type Page, expect, test } from "@playwright/test";
import { totp } from "./totp";

const PASSWORD = "senha-e2e-whiteoven";

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test("an owner signs in, picks a store and keeps the session after a reload", async ({
  page,
}) => {
  await signIn(page, "dona@e2e.test");
  await expect(page).toHaveURL(/\/lojas$/);
  await page.getByRole("button", { name: /Pizzaria pizzaria-bairro/ }).click();
  await expect(page).toHaveURL(/\/loja$/);
  await expect(page.getByRole("banner")).toContainText(
    "Pizzaria pizzaria-bairro",
  );
  const nav = page.getByRole("navigation", { name: "Seções da loja" });
  await expect(nav.getByRole("link")).toHaveText([
    "Início",
    "Cardápio",
    "Equipe",
  ]);

  // The access token lives only in memory: nothing in storage, and the only cookie is the
  // HttpOnly refresh cookie scoped to the auth path.
  expect(
    await page.evaluate(() => [
      localStorage.length,
      sessionStorage.length,
      document.cookie,
    ]),
  ).toEqual([0, 0, ""]);
  const cookies = await page.context().cookies();
  expect(
    cookies.map((cookie) => [cookie.name, cookie.httpOnly, cookie.path]),
  ).toEqual([["__Secure-wo_staff_refresh", true, "/v1/admin/auth"]]);

  await page.reload();
  await expect(page).toHaveURL(/\/loja$/);
  await expect(page.getByRole("banner")).toContainText(
    "Pizzaria pizzaria-bairro",
  );

  await page.getByRole("link", { name: "Trocar loja" }).click();
  await page.getByRole("button", { name: /Pizzaria pizzaria-centro/ }).click();
  await expect(page.getByRole("banner")).toContainText(
    "Pizzaria pizzaria-centro",
  );

  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/entrar$/);
  await page.reload();
  await expect(page).toHaveURL(/\/entrar$/);
});

test("staff see only their sections and cannot open others by URL", async ({
  page,
}) => {
  await signIn(page, "equipe@e2e.test");
  // A single store is entered directly.
  await expect(page).toHaveURL(/\/loja$/);
  const nav = page.getByRole("navigation", { name: "Seções da loja" });
  await expect(nav.getByRole("link")).toHaveText(["Início"]);
  await page.goto("/loja/cardapio");
  await expect(page).toHaveURL(/\/loja$/);
  await page.goto("/plataforma");
  await expect(page).toHaveURL(/\/loja$/);
});

test("wrong credentials show an alert and keep the person on the sign-in page", async ({
  page,
}) => {
  await signIn(page, "dona@e2e.test", "senha-errada");
  await expect(page.getByRole("alert")).toHaveText(
    "E-mail ou senha incorretos.",
  );
  await expect(page).toHaveURL(/\/entrar$/);
});

test("signing in works with the keyboard only", async ({ page }) => {
  await page.goto("/entrar");
  await expect(
    page.getByRole("heading", { name: "Entrar no painel" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("E-mail")).toBeFocused();
  await page.keyboard.type("equipe@e2e.test");
  await page.keyboard.press("Tab");
  await expect(page.getByLabel("Senha")).toBeFocused();
  await page.keyboard.type(PASSWORD);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/loja$/);
  await expect(page.getByRole("heading", { name: "Início" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Pular para o conteúdo" }),
  ).toBeFocused();
});

test("an operator enrolls the second factor before reaching the platform", async ({
  page,
}) => {
  await signIn(page, "operador@e2e.test");
  await expect(page).toHaveURL(/\/seguranca\/mfa$/);
  await page.goto("/lojas");
  await expect(page).toHaveURL(/\/seguranca\/mfa$/);

  await page.getByRole("button", { name: "Gerar chave" }).click();
  const secret = (await page.getByTestId("mfa-secret").textContent())!.trim();
  await page.getByLabel("Código de 6 dígitos").fill(totp(secret));
  await page.getByRole("button", { name: "Ativar" }).click();
  await expect(
    page.getByTestId("recovery-codes").getByRole("listitem"),
  ).toHaveCount(10);
  await page.getByRole("button", { name: "Já guardei os códigos" }).click();
  await expect(page).toHaveURL(/\/plataforma$/);
  await expect(page.getByRole("heading", { name: "Plataforma" })).toBeVisible();

  // The next sign-in asks for the second factor.
  await page.getByRole("button", { name: "Sair" }).click();
  await signIn(page, "operador@e2e.test");
  await expect(
    page.getByRole("heading", { name: "Verificação em duas etapas" }),
  ).toBeVisible();
  await page.waitForTimeout(31_000 - (Date.now() % 30_000));
  await page.getByLabel("Código do aplicativo autenticador").fill(totp(secret));
  await page.getByRole("button", { name: "Verificar" }).click();
  await expect(page).toHaveURL(/\/plataforma$/);
});
