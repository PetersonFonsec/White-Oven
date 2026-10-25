# ADR 0011: cardápio público e cache por versão do catálogo

- **Status:** implementado em M2.6
- **Data:** 2026-10-25
- **Milestone:** M2.6

## Contexto

O app do cliente lê `GET /v1/public/stores/{slug}/menu` sem autenticação. O cardápio é derivado das tabelas do catálogo no momento da leitura, sem rascunho/publicação ([domain-model](../architecture/domain-model.md#publicação-do-cardápio)), e montá-lo custa cerca de dez consultas. O critério de aceite pede cache por tenant com invalidação em qualquer alteração, e a API pode rodar com mais de uma instância: um cache invalidado só pelo processo que gravou serviria cardápio velho nas outras.

## Decisão

- A tabela `catalog_versions` (uma linha por tenant, RLS forçado) guarda `version`. Um trigger `AFTER INSERT OR UPDATE OR DELETE` em cada tabela do catálogo incrementa a versão na mesma transação da escrita. A função do trigger é `SECURITY DEFINER`; o papel `whiteoven_app` só tem `SELECT` na tabela. Tenant sem linha nunca alterou o catálogo (versão 0).
- Cada requisição, dentro de `TenantTransactions.run`, lê primeiro o nome/slug da loja e a versão (uma linha) e só depois o catálogo. O cardápio montado é guardado em memória por tenant com essa versão. Como a leitura do catálogo vem depois da leitura da versão, o conteúdo guardado é sempre igual ou mais novo que a versão sob a qual está; nunca mais velho. Escritas feitas por qualquer instância ou pela migration invalidam todas.
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

- Toda nova tabela do catálogo que afete o cardápio público precisa do trigger `whiteoven_bump_catalog_version()` na sua migration.
- Escritas concorrentes no catálogo do mesmo tenant serializam na linha de `catalog_versions` até o commit; com o volume de edição esperado do painel, isso é aceitável.
- A marca visual (`BrandTheme`: logotipo, ícone, cores) ainda não existe; ela entra com o editor de marca (M3.5). Até lá a "marca" do cardápio é o nome público da loja.
