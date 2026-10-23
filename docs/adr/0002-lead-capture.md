# ADR 0002 — Captação temporária via Astro e SQLite

Status: adotado na M0.1-B. Sem deploy de produção.

## Contexto e alternativas

A landing Astro já existe; precisamos validar demanda, plano e aquisição antes da API multi-tenant. O banco principal do SaaS ainda não tem consumidor.

| Opção                                | Avaliação                                                                                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Endpoint Astro + SQLite local        | Escolhida: um processo, transações, exportação JSON, sem serviço pago, contrato migrável.                                          |
| Arquivo JSON/CSV                     | Evitaria driver, mas exige implementar atomicidade, concorrência e recuperação; inadequado para confirmação durável.               |
| PostgreSQL/NestJS agora              | Adicionaria operação e estrutura prematuras para um formulário.                                                                    |
| Serviço externo de formulários/banco | Exigiria aprovação, avaliação de privacidade e fornecedor; desnecessário nesta etapa.                                              |
| `node:sqlite`                        | Ainda classificado como release candidate na documentação Node 24 consultada; preferimos driver consolidado com suporte a Node 22. |

## Decisão

Usar `@astrojs/node` standalone compatível com Astro 5 e `better-sqlite3`. São as duas dependências runtime novas; o contrato compartilhado é workspace local, e tipos do driver são somente desenvolvimento. A homepage continua pré-renderizada; `/api/leads` e `/privacidade` usam Node em runtime. Saída `server` substitui a publicação exclusivamente estática prevista em M0.

SQLite usa WAL, `synchronous=FULL`, transação imediata para lead e idempotência, queries parametrizadas, diretório 0700 e banco 0600. O servidor só confirma sucesso após commit. Sem ID de tenant, ORM, autenticação ou API de leitura. Exportação e exclusão são ferramentas locais do operador, com acesso ao arquivo.

Chave UUID v4 retida por 24 horas: retry idêntico retorna o mesmo cadastro; reutilização com conteúdo diferente retorna 409. Reenvios com outra chave e mesmos dados de contato/interesse são agregados por 15 minutos; depois novo interesse é permitido. O digest para deduplicação é derivado apenas dos campos enviados voluntariamente, não é fingerprint do dispositivo. Attribution inicial é preservada nessa janela.

## Consequências e limites

Exige disco persistente, permissões, backups protegidos, limpeza diária e um processo Node. Não usar filesystem efêmero, réplica horizontal ou compartilhamento em rede sem rever decisão e rate limiting. Driver nativo exige binário compatível ou toolchain de compilação. SQLite não cifra dados em repouso; proteção de volume/backups é responsabilidade da futura operação.

Limite global de 60 tentativas válidas quanto a origem por 10 minutos por processo, sem IP e sem confiar em `X-Forwarded-For`. Mitiga rajadas simples, mas pode ser consumido por um atacante e afetar outros visitantes. Reinício limpa o orçamento. Honeypot, tamanho máximo, esquema fechado e origem exata complementam a proteção. Abuso persistente exigirá revisão e proteção no proxy, sem introduzir CAPTCHA/terceiros silenciosamente.

Contrato JSON, IDs UUID e timestamps UTC permitem futura importação na API WhiteOven. Essa migração não está implementada. Nenhum fornecedor ou infraestrutura externa foi configurado.

## Referências técnicas

- [Astro: on-demand rendering](https://v5.docs.astro.build/en/guides/on-demand-rendering/).
- [Adapter Node](https://docs.astro.build/en/guides/integrations-guide/node/).
- [Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).
