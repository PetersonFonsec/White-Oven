# ADR 0009: catálogo administrativo tenant-scoped

- **Status:** aceito
- **Data:** 2026-10-24
- **Milestone:** M2.3

## Contexto

O motor de preço e os contratos do catálogo já existem, mas a API ainda não persiste categorias, tamanhos, ingredientes, sabores e preços por tamanho. O catálogo é dado comercial de cada pizzaria e deve respeitar as garantias de isolamento definidas no ADR 0006.

## Decisão

- Persistir o recorte de M2.3 em tabelas com `tenant_id`, RLS habilitado e forçado, filtro MikroORM padrão e FKs compostas `(tenant_id, id)`.
- Restringir as rotas administrativas a OWNER e MANAGER; a checagem transacional também valida membership, sessão e estado do tenant.
- Arquivar entidades do catálogo com `archived_at`, preservando referências; remover somente relações sabor–ingrediente e preços explícitos.
- Gravar cada mudança de preço e seu evento de auditoria na mesma transação. A aplicação usa funções estreitas para escrever e ler `audit_events`, que permanece sem grants diretos para `whiteoven_app`.
- Um sabor só pode referenciar categoria `PIZZA`; essa invariável também é protegida no banco.

## Consequências

- M2.3 fornece gestão autenticada do catálogo e consulta de sua trilha de auditoria.
- O cardápio público, produtos simples, crostas, extras, políticas de preço e publicação continuam em milestones seguintes.
- A migration é forward-only e adiciona todas as tabelas à matriz de isolamento PostgreSQL.
