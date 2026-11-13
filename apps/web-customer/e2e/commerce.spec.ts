import { test, expect } from "@playwright/test";

test("real store: halves, customer, quote, lost response, restore, history and reorder", async ({
  page,
}, info) => {
  test.skip(
    !process.env.TEST_DATABASE_OWNER_URL,
    "Requires the isolated PostgreSQL API.",
  );
  test.setTimeout(90000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  const base = "/lojas/forno-teste";
  await page.goto(base + "/cardapio");
  await page.getByLabel("Buscar por nome ou ingrediente").fill("calabresa");
  const card = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Calabresa" }) });
  await card.getByRole("link", { name: "Montar pizza" }).click();
  await page.getByRole("button", { name: /Grande/ }).click();
  await page.getByRole("button", { name: "Meio a meio" }).click();
  await expect(
    page.getByRole("button", { name: "Adicionar à sacola" }),
  ).toBeDisabled();
  const right = page.getByRole("group", { name: "Metade direita" });
  await right.getByLabel("Sabor").selectOption({ label: "Marguerita" });
  await right.getByLabel("Sem Tomate").check();
  await right.getByLabel("Adicionar Azeitona").check();
  await expect(page.getByText("Total R$ 55,00", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Adicionar à sacola" }).click();
  await expect(
    page.getByRole("heading", { name: "Sacola", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByText(/Metade direita: Marguerita, sem Tomate/),
  ).toBeVisible();
  const other = await page.context().newPage();
  try {
    await other.goto(base + "/sacola");
    await expect(
      other.getByText(/A sacola desta loja está aberta em outra aba/),
    ).toBeVisible();
    await other.goto("/lojas/loja-ausente/sacola");
    await expect(
      other.getByRole("heading", { name: "Sua sacola está vazia" }),
    ).toBeVisible();
    await expect(other.getByText(/Marguerita/)).toHaveCount(0);
  } finally {
    await other.close();
  }
  await page.getByRole("link", { name: "Cardápio", exact: true }).click();
  await page.getByRole("button", { name: "Bebidas", exact: true }).click();
  await page.getByRole("button", { name: "Adicionar à sacola" }).click();
  await page.getByRole("link", { name: "Sacola (2)" }).click();
  const soda = page
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: "Refrigerante" }) });
  await soda.getByRole("button", { name: "Aumentar Refrigerante" }).click();
  await expect(soda.getByText("R$ 16,00", { exact: true })).toBeVisible();
  await soda.getByRole("button", { name: "Remover" }).click();
  await expect(soda).toHaveCount(0);
  await page.getByRole("link", { name: "Ir para checkout" }).click();
  await page.getByRole("link", { name: "Entrar para pedir" }).click();
  await page.getByRole("link", { name: "Criar uma conta" }).click();
  await page.getByLabel("Nome", { exact: true }).fill("Cliente sintético");
  await page
    .getByLabel("E-mail", { exact: true })
    .fill("web-" + info.project.name + "@teste.invalid");
  await page.getByLabel("Senha", { exact: true }).fill("Teste-web-1234567");
  await page.getByRole("checkbox", { name: /Li e aceito/ }).check();
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(
    page.getByRole("heading", { name: "Checkout", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Conta", exact: true }).click();
  await page.getByRole("button", { name: "Novo endereço" }).click();
  for (const [field, value] of Object.entries({
    "Nome do endereço": "Casa",
    CEP: "01310-100",
    Rua: "Rua de Teste",
    Número: "10",
    Bairro: "Centro",
    Cidade: "São Paulo",
    UF: "SP",
  }))
    await page.getByLabel(field, { exact: true }).fill(value);
  await page.getByRole("button", { name: "Salvar endereço" }).click();
  await expect(page.getByRole("button", { name: "Editar Casa" })).toBeVisible();
  await page.getByRole("button", { name: "Editar Casa" }).click();
  await page.getByLabel("Número", { exact: true }).fill("11");
  await page.getByRole("button", { name: "Salvar endereço" }).click();
  await expect(page.getByText(/Rua de Teste, 11/)).toBeVisible();
  await page.goto(base + "/checkout");
  await page.getByLabel("Recebimento").selectOption("PICKUP");
  await page
    .getByRole("combobox", { name: "Pagamento", exact: true })
    .selectOption("PIX_ON_DELIVERY");
  await page.getByRole("button", { name: "Consultar total" }).click();
  await expect(page.getByText("Total R$ 55,00", { exact: true })).toBeVisible();
  const requests: { key: string | undefined; body: string | null }[] = [];
  await page.route("**/me/orders", async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    requests.push({
      key: route.request().headers()["idempotency-key"],
      body: route.request().postData(),
    });
    if (requests.length === 1) {
      const response = await route.fetch();
      expect(response.ok()).toBe(true);
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "Confirmar pedido" }).click();
  await expect(
    page.getByRole("heading", { name: "Confirmação pendente" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Recuperar o mesmo pedido" }),
  ).toBeEnabled();
  await page.reload();
  await page.getByRole("link", { name: "Conta", exact: true }).click();
  await page.getByRole("button", { name: "Sair da conta" }).click();
  await expect(
    page.getByRole("button", { name: "Entrar", exact: true }),
  ).toBeEnabled();
  await page.goto(base + "/checkout");
  await page.getByRole("link", { name: "Entrar na conta" }).click();
  await page.getByRole("link", { name: "Criar uma conta" }).click();
  await page.getByLabel("Nome", { exact: true }).fill("Outra conta");
  await page
    .getByLabel("E-mail", { exact: true })
    .fill("outra-" + info.project.name + "@teste.invalid");
  await page.getByLabel("Senha", { exact: true }).fill("Teste-web-1234567");
  await page.getByRole("checkbox", { name: /Li e aceito/ }).check();
  await page.getByRole("button", { name: "Criar conta" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "conta original" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Recuperar o mesmo pedido" }),
  ).toHaveCount(0);
  expect(requests).toHaveLength(1);
  await page.getByRole("link", { name: "Trocar de conta" }).click();
  await page.getByRole("button", { name: "Sair da conta" }).click();
  await page
    .getByLabel("E-mail", { exact: true })
    .fill("web-" + info.project.name + "@teste.invalid");
  await page.getByLabel("Senha", { exact: true }).fill("Teste-web-1234567");
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await page.getByRole("button", { name: "Recuperar o mesmo pedido" }).click();
  await expect(
    page.getByRole("heading", { name: "Pedido confirmado" }),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0].key).toBeTruthy();
  expect(requests[0]).toEqual(requests[1]);
  await page.getByRole("link", { name: "Acompanhar pedido" }).click();
  await expect(page.getByText("Pizza Grande Meio a Meio")).toBeVisible();
  await page.getByRole("link", { name: "Voltar aos pedidos" }).click();
  await page.getByRole("link", { name: /^Pedido #\d+$/ }).click();
  await page.getByRole("button", { name: "Pedir novamente" }).click();
  await expect(
    page.getByRole("heading", { name: "Sacola", exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
