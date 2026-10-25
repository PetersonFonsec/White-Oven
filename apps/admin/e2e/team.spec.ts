import { type Page, expect, test } from "@playwright/test";

const PASSWORD = "senha-e2e-whiteoven";
const NEW_PASSWORD = "senha-nova-da-equipe-e2e";
const STORE = /Pizzaria pizzaria-bairro/;

async function signIn(page: Page, email: string, password = PASSWORD) {
  await page.goto("/entrar");
  await page.getByLabel("E-mail").fill(email);
  await page.getByLabel("Senha").fill(password);
  await page.getByRole("button", { name: "Entrar" }).click();
}

test("an owner invites a person by link, changes their role and revokes them", async ({
  page,
  browser,
}) => {
  await signIn(page, "dona@e2e.test");
  await page.getByRole("button", { name: STORE }).click();
  await page
    .getByRole("navigation", { name: "Seções da loja" })
    .getByRole("link", { name: "Equipe" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Equipe", level: 1 }),
  ).toBeVisible();
  // The owner's own row has no actions: the store always keeps an owner.
  const own = page.getByRole("listitem").filter({ hasText: "Você" });
  await expect(own).toContainText("Outro dono pode alterar o seu papel.");
  await expect(own.getByRole("button")).toHaveCount(0);

  await page.getByLabel("E-mail").fill("nova-pessoa@e2e.test");
  await page.getByLabel("Papel", { exact: true }).selectOption("STAFF");
  await page.getByRole("button", { name: "Gerar convite" }).click();
  const link = page.getByLabel("Link de convite");
  await expect(link).toHaveValue(/\/equipe\/convite\/[A-Za-z0-9_-]{43}$/);
  const inviteUrl = await link.inputValue();
  await expect(
    page.getByRole("listitem", { name: "nova-pessoa@e2e.test" }),
  ).toContainText("Equipe");

  // The invitee, in a browser of their own.
  const invitee = await browser.newContext();
  const guest = await invitee.newPage();
  await guest.goto(inviteUrl);
  await expect(guest).toHaveURL(/\/equipe\/convite\/aceitar$/);
  await expect(guest.getByRole("main")).toContainText(
    "Pizzaria pizzaria-bairro convidou nova-pessoa@e2e.test",
  );
  await guest.getByLabel("Seu nome").fill("Nova Pessoa");
  await guest.getByLabel("Crie uma senha").fill(NEW_PASSWORD);
  await guest.getByLabel("Repita a senha").fill(NEW_PASSWORD);
  await guest.getByRole("button", { name: "Aceitar convite" }).click();
  await expect(guest.getByRole("status")).toContainText(
    "Você agora faz parte da equipe de Pizzaria pizzaria-bairro como Equipe.",
  );
  await signIn(guest, "nova-pessoa@e2e.test", NEW_PASSWORD);
  await expect(guest).toHaveURL(/\/loja$/);
  await expect(guest.getByRole("banner")).toContainText(
    "Pizzaria pizzaria-bairro",
  );

  // The owner promotes the new person to manager; the next request already has the new role.
  await page.reload();
  const member = page.getByRole("listitem", { name: "Nova Pessoa" });
  await member.getByLabel("Papel de Nova Pessoa").selectOption("MANAGER");
  await member.getByRole("button", { name: "Alterar papel" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Nova Pessoa agora é Gerente.",
  );
  await guest.reload();
  await expect(
    guest
      .getByRole("navigation", { name: "Seções da loja" })
      .getByRole("link", { name: "Cardápio" }),
  ).toBeVisible();

  // Revoking ends the person's session in this store at once.
  page.once("dialog", (dialog) => void dialog.accept());
  await page
    .getByRole("listitem", { name: "Nova Pessoa" })
    .getByRole("button", { name: "Revogar acesso" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "As sessões da pessoa nesta loja foram encerradas.",
  );
  await expect(page.getByRole("listitem", { name: "Nova Pessoa" })).toHaveCount(
    0,
  );
  await guest.reload();
  await expect(guest).toHaveURL(/\/entrar$/);
  await invitee.close();
});
