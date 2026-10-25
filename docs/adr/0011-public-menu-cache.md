# ADR 0011: cardápio público e cache por versão do catálogo

- **Status:** implementado em M2.6
- **Data:** 2026-10-25
- **Milestone:** M2.6

## Contexto

O app do cliente lê `GET /v1/public/stores/{slug}/menu` sem autenticação. O cardápio é derivado das tabelas do catálogo no momento da leitura, sem rascunho/publicação ([domain-model](../architecture/domain-model.md#publicação-do-cardápio)), e montá-lo custa cerca de dez consultas. O critério de aceite pede cache por tenant com invalidação em qualquer alteração, e a API pode rodar com mais de uma instância: um cache invalidado só pelo processo que gravou serviria cardápio velho nas outras.

## Decisão

- A tabela `catalog_versions` (uma linha por tenant, RLS forçado) guarda `version`. Um trigger `AFTER INSERT OR UPDATE OR DELETE ... FOR EACH STATEMENT` em cada tabela do catálogo incrementa a versão do tenant da transação uma vez por comando, então uma alteração em lote de preços ou disponibilidade custa um único upsert. A função do trigger é `SECURITY DEFINER`; o papel `whiteoven_app` só tem `SELECT` na tabela. Tenant sem linha nunca alterou o catálogo (versão 0).
- O trigger por comando usa o tenant da transação (`whiteoven_current_tenant()`): o RLS forçado só deixa um comando alterar linhas desse tenant, e um trigger `BEFORE UPDATE OF tenant_id` recusa mover linha do catálogo para outro tenant (`23514 catalog_tenant_immutable`). Sem contexto de tenant nenhuma linha muda, e não há o que incrementar.
- Cada requisição lê nome/slug da loja, a versão e todo o catálogo numa única transação `REPEATABLE READ` (`TenantTransactions.run` aceita o nível de isolamento). Todas as consultas veem o mesmo snapshot, então o cardápio guardado em memória corresponde exatamente à versão sob a qual está, sem misturar uma escrita confirmada no meio da montagem. Escritas feitas por qualquer instância ou fora da API invalidam todas.
- O cache é LRU com até 500 tenants por instância. Nome e slug da loja são lidos a cada requisição e não entram no cache.
- O status da loja continua verificado a cada requisição pelo `StoreTenantGuard` (`TenantStatusPolicy`, capacidade `publicMenu`): loja que não está `ACTIVE` responde `403 TENANT_NOT_ACTIVE` mesmo com cardápio em cache.
- A resposta usa `Cache-Control: no-cache` com o ETag padrão do Express: clientes e proxies revalidam a cada uso e recebem `304` quando nada mudou. Não há cache compartilhado de CDN, para que uma suspensão valha imediatamente.
- Só itens pedíveis aparecem: não arquivados, disponíveis, em categoria não arquivada e com preço em um tamanho disponível. Tamanhos sem nenhuma pizza, bordas e adicionais sem preço em tamanho listado, categorias vazias e ingredientes arquivados ficam de fora. Os campos internos (`archived`, `available`, `sortOrder`, ids de tenant) não são expostos; a ordem dos arrays já é a de exibição.
- `pricingPolicy` é `null` quando a loja ainda não definiu política: Q-06 segue aberta e o contrato não tem estratégia padrão.

## Alternativas descartadas

- **Invalidação só em processo** (evento local após a escrita): simples, mas incorreta com duas instâncias e com escritas fora da API.
- **Cache compartilhado (Redis) ou `LISTEN/NOTIFY`:** nova dependência ou conexão dedicada sem ganho para o volume do MVP.
- **Versões publicadas de cardápio:** mantém-se para quando houver agendamento de mudanças.

## Consequências

- Toda nova tabela do catálogo que afete o cardápio público precisa do trigger por comando `whiteoven_bump_catalog_version()` na sua migration.
- Toda nova tabela do catálogo também recebe o trigger `BEFORE UPDATE OF tenant_id` com `whiteoven_guard_catalog_tenant()`; um teste falha se alguma tabela `catalog_*` ou `pizza_sizes` ficar sem os dois triggers.
- Escritas concorrentes no catálogo do mesmo tenant serializam na linha de `catalog_versions` até o commit (um upsert por comando, não por linha); com o volume de edição esperado do painel, isso é aceitável.
- Uma leitura `REPEATABLE READ` só de consulta não sofre falha de serialização no PostgreSQL.
- A marca visual (`BrandTheme`: logotipo, ícone, cores) ainda não existe; ela entra com o editor de marca (M3.5). Até lá a "marca" do cardápio é o nome público da loja.
