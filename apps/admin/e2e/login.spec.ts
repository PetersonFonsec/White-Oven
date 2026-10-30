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
    "Pedidos",
    "Histórico",
    "Relatório",
    "Cardápio",
    "Configurações",
    "Marca",
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
  await expect(page.getByTestId("logout-unconfirmed")).toHaveCount(0);
  expect(await page.context().cookies()).toEqual([]);
  await page.reload();
  await expect(page).toHaveURL(/\/entrar$/);
});

test("a logout the API cannot confirm is reported and never resumed by a reload", async ({
  page,
}) => {
  await signIn(page, "equipe@e2e.test");
  await expect(page).toHaveURL(/\/loja$/);
  const refreshes: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/admin/auth/refresh"))
      refreshes.push(request.url());
  });
  await page.route("**/v1/admin/auth/logout", (route) => route.abort());

  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/entrar$/);
  const warning = page.getByTestId("logout-unconfirmed");
  await expect(warning).toContainText("não conseguimos confirmar");
  // Honest state: the refresh cookie and its server session still exist.
  expect((await page.context().cookies()).map((c) => c.name)).toEqual([
    "__Secure-wo_staff_refresh",
  ]);

  // A reload retries the logout and does not resume the session, even though the cookie works.
  await page.reload();
  await expect(page).toHaveURL(/\/entrar$/);
  await expect(warning).toBeVisible();
  await page.goto("/loja");
  await expect(page).toHaveURL(/\/entrar$/);
  expect(refreshes).toEqual([]);
  expect(
    await page.evaluate(() => JSON.stringify({ ...localStorage })),
  ).not.toMatch(/token|eyJ/i);

  await page.unroute("**/v1/admin/auth/logout");
  await page
    .getByRole("button", { name: "Tentar encerrar a sessão de novo" })
    .click();
  await expect(warning).toHaveCount(0);
  expect(await page.context().cookies()).toEqual([]);
  await page.reload();
  await expect(page).toHaveURL(/\/entrar$/);
  await expect(warning).toHaveCount(0);
});

test("signing in again while the previous logout is still pending keeps the new session", async ({
  page,
}) => {
  await signIn(page, "equipe@e2e.test");
  await expect(page).toHaveURL(/\/loja$/);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/v1/admin/auth/logout", async (route) => {
    await held;
    await route.continue();
  });
  const signIns: string[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/v1/admin/auth/login"))
      signIns.push(request.url());
  });

  await page.getByRole("button", { name: "Sair" }).click();
  await expect(page).toHaveURL(/\/entrar$/);
  await page.getByLabel("E-mail").fill("equipe@e2e.test");
  await page.getByLabel("Senha").fill(PASSWORD);
  await page.getByRole("button", { name: "Entrar" }).click();
  await expect(page.getByRole("button", { name: "Entrando…" })).toBeVisible();
  // The sign-in waits for the logout: answered later, the logout would clear the new cookie.
  expect(signIns).toEqual([]);

  release();
  await expect(page).toHaveURL(/\/loja$/);
  expect(signIns).toHaveLength(1);
  await page.reload();
  await expect(page).toHaveURL(/\/loja$/);
  await expect(page.getByRole("banner")).toContainText(
    "Pizzaria pizzaria-centro",
  );
});

test("staff see only their sections and cannot open others by URL", async ({
  page,
}) => {
  await signIn(page, "equipe@e2e.test");
  // A single store is entered directly.
  await expect(page).toHaveURL(/\/loja$/);
  const nav = page.getByRole("navigation", { name: "Seções da loja" });
  await expect(nav.getByRole("link")).toHaveText([
    "Início",
    "Pedidos",
    "Histórico",
  ]);
  await page.goto("/loja/cardapio");
  await expect(page).toHaveURL(/\/loja$/);
  await page.goto("/loja/relatorio");
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
  // The next stop after the page title is the home page's first control: pausing orders.
  const pause = page.getByRole("button", { name: "Pausar 15 min" });
  await expect(pause).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(pause).toBeFocused();
});

test("an operator enrolls the second factor before reaching the platform", async ({
  page,
  browser,
}) => {
  // Waits up to 31 s for a fresh TOTP window below, so the default 30 s budget is not enough.
  test.setTimeout(90_000);
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

  await expect(
    page.getByRole("heading", { name: "Área de plataforma" }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toContainText("pizzaria-centro");

  const slug = `loja-m32-${Date.now()}`;
  const ownerEmail = `owner-${Date.now()}@e2e.test`;
  await page.getByLabel("Nome da pizzaria").fill("Loja M3.2 E2E");
  await page.getByLabel("Identificador da loja").fill(slug);
  await page.getByLabel("E-mail da pessoa responsável").fill(ownerEmail);
  await page.getByRole("button", { name: "Cadastrar e gerar convite" }).click();
  await expect(
    page.getByText("Pizzaria cadastrada e convite criado.", { exact: true }),
  ).toBeVisible();
  const inviteInput = page.getByLabel("Link de convite");
  await expect(inviteInput).toHaveValue(
    /^http:\/\/127\.0\.0\.1:4310\/invite\/[A-Za-z0-9_-]{43}$/,
  );
  const inviteUrl = await inviteInput.inputValue();

  const createdTenantRow = page.getByRole("row").filter({ hasText: slug });
  await expect(createdTenantRow).toContainText("Aguardando primeiro acesso");
  await createdTenantRow
    .getByRole("button", { name: "Suspender Loja M3.2 E2E" })
    .click();
  const suspendDialog = page.getByRole("alertdialog");
  await expect(suspendDialog).toContainText(
    "Pedidos aguardando aceite serão recusados",
  );
  await suspendDialog
    .getByRole("button", { name: "Suspender pizzaria" })
    .click();
  await expect(createdTenantRow).toContainText("Suspensa");
  // M6.1: an active store always has a current plan; the first one starts immediately.
  await expect(createdTenantRow).toContainText("Sem plano");
  await createdTenantRow
    .getByRole("button", { name: "Plano de Loja M3.2 E2E" })
    .click();
  const planDialog = page.getByRole("dialog", {
    name: "Plano de Loja M3.2 E2E",
  });
  await expect(planDialog).toContainText("começa a valer agora");
  await planDialog.getByLabel(/Flex/).check();
  await planDialog.getByRole("button", { name: "Salvar plano" }).click();
  await expect(page.getByRole("status").first()).toContainText(
    "Loja M3.2 E2E está no plano Flex.",
  );
  await expect(createdTenantRow).toContainText("Flex");
  await createdTenantRow
    .getByRole("button", { name: "Reativar Loja M3.2 E2E" })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: "Reativar pizzaria" })
    .click();
  await expect(createdTenantRow).toContainText("Ativa");

  // The invitation is usable on the recipient's signed-out browser and its token disappears
  // from the address bar after one successful redemption.
  const invitee = await browser.newPage();
  await invitee.goto(inviteUrl);
  await expect(
    invitee.getByRole("heading", { name: "Aceitar convite" }),
  ).toBeVisible();
  await expect(invitee).toHaveURL(/\/invite\/aceitar$/);
  await invitee.reload();
  await expect(invitee.getByRole("alert")).toContainText(
    "Abra novamente o link original recebido",
  );
  await invitee.goto(inviteUrl);
  await expect(invitee).toHaveURL(/\/invite\/aceitar$/);
  await invitee.getByLabel("Seu nome").fill("Pessoa Responsável E2E");
  await invitee.getByLabel("Crie uma senha").fill("senham3_2-segura");
  await invitee.getByLabel("Repita a senha").fill("senham3_2-segura");
  await invitee.getByRole("button", { name: "Criar acesso de dono" }).click();
  await expect(invitee).toHaveURL(/\/invite\/concluido$/);
  await expect(invitee.getByRole("status")).toContainText("acesso de dono");
  await invitee.getByRole("link", { name: "Entrar no painel" }).click();
  await expect(invitee).toHaveURL(/\/entrar$/);
  await invitee.getByLabel("E-mail").fill(ownerEmail);
  await invitee.getByLabel("Senha").fill("senham3_2-segura");
  await invitee.getByRole("button", { name: "Entrar" }).click();
  await expect(invitee).toHaveURL(/\/loja$/);
  await expect(invitee.getByRole("banner")).toContainText("Loja M3.2 E2E");
  await invitee.close();
});
