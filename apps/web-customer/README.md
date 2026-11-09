# Aplicativo web do consumidor

Aplicação Angular 21 para o cliente de cada pizzaria. Use a raiz do monorepo, Node nas versões aceitas em `package.json` e pnpm 11.25.0.

```sh
pnpm install --frozen-lockfile
pnpm api:dev
# Em outro terminal
pnpm web:dev
```

Acesse http://localhost:4300 e informe o identificador de uma pizzaria cadastrada. O link direto é `/lojas/<slug>`. Configure PostgreSQL e a API local conforme o README da raiz. O proxy de desenvolvimento encaminha `/v1/**` para `127.0.0.1:3000`.

A partir da loja, é possível consultar o cardápio, montar pizzas inteiras ou meio a meio, adicionar produtos à sacola, entrar ou criar conta, gerenciar endereços, cotar, confirmar, acompanhar e repetir pedidos. O checkout oferece as formas de pagamento na entrega configuradas pela pizzaria.

A sacola e a sessão usam IndexedDB, Web Crypto e Web Locks. Execute em `localhost` ou HTTPS e permita armazenamento. Uma aba por loja pode editar a sacola. A segunda aba oferece uma tentativa de reabertura depois que a primeira for fechada.

```sh
pnpm --filter @whiteoven/web-customer typecheck
pnpm --filter @whiteoven/web-customer test
pnpm web:build
pnpm exec playwright install chromium
pnpm test:e2e:web
```

Com `TEST_DATABASE_OWNER_URL` configurada para o PostgreSQL de desenvolvimento, o Playwright cria uma base temporária, roda as migrações, inicia a API na porta 3102 e o Angular na porta 4320. O teste faz um pedido em cada largura, interrompe a primeira resposta após o commit da API e compara a chave e o corpo ao recuperar o resultado. A base é descartada ao encerrar. Sem a variável, apenas os cenários com HTTP controlado são executados.

O build fica em `dist/web-customer/browser`. A hospedagem requer fallback da SPA nas rotas de navegação, proxy da API em `/v1` e preservação das páginas legais servidas pela API em `/lojas/<slug>/{privacidade,termos,excluir-conta}`. Veja o [diagnóstico e as decisões de arquitetura](../../docs/architecture/web-customer.md).
