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

Chave UUID v4 retida por 24 horas: retry idêntico retorna o mesmo cadastro; reutilização com conteúdo diferente retorna 409. Reenvios com outra chave e mesmos dados de contato/interesse são agregados por 15 minutos; depois novo interesse é permitido. O hash de idempotência inclui o payload normalizado e o SHA-256 do snapshot da política (versão, texto, controlador, contato e retenção, em ordem fixa). Mudança nesse snapshot retorna 409 com a mesma chave; também participa da deduplicação, para não reaproveitar consentimento de outra política. Alterações materiais continuam exigindo nova versão. A versão avançou para `2026-10-23.2` com a proteção temporária por endereço de conexão e o tratamento de cópias secundárias.

O digest para deduplicação é derivado apenas dos campos enviados voluntariamente, não é fingerprint do dispositivo. Attribution inicial é preservada nessa janela.

## Consequências e limites

Exige disco persistente, permissões, backups protegidos, limpeza diária e um processo Node. Não usar filesystem efêmero, réplica horizontal ou compartilhamento em rede sem rever decisão e rate limiting. Driver nativo exige binário compatível ou toolchain de compilação. SQLite não cifra dados em repouso; proteção de volume/backups é responsabilidade da futura operação.

Limite de 10 tentativas por cliente/10 minutos, aplicado antes do orçamento global de emergência de 600. Rejeições por cliente não consomem esse orçamento. Identidade usa HMAC-SHA-256 do IP com chave aleatória por processo; só o digest permanece em memória por até dez minutos, com tabela limitada a 4.096 clientes. Não há IP no SQLite, nos logs da aplicação ou em analytics. NAT compartilha o limite; ataque distribuído ainda pode atingir o orçamento de emergência. Reinício limpa os contadores; múltiplas instâncias exigirão proteção compartilhada antes de escalar.

`pnpm start` envolve o handler standalone Astro num servidor HTTP Node: identidade vem do socket, com contexto isolado por requisição. `X-Forwarded-For` só é aceito de IPs exatos explicitamente confiáveis, com um único IP válido, e removido antes de chegar ao parser Astro. O último proxy deve substituir o header com o endereço verificado da conexão recebida. Origem pública sem configuração de proxy mantém envio desativado; entrypoint Astro direto sem o contexto do inicializador não habilita captação em produção. O servidor usa 128 conexões, headers de 8 KiB/5s, requestTimeout de 7s, inatividade de 8s e keep-alive de 5s. O endpoint limita leitura total a 5s/8 KiB, 2 leituras por cliente e 16 no processo, liberadas em `finally`. Cancelamento de stream não é aguardado indefinidamente.

O proxy real continua fora da milestone: é necessário verificar encaminhamento, tamanho/tempo e proteção de borda antes de abrir inscrições públicas. Nenhuma configuração de Caddy/Orbia/VPS foi aplicada. Essas defesas locais não oferecem proteção contra DDoS de rede.

Exclusões de titulares exigem registro operacional restrito abrangendo exports e backups, com isolamento de cópias imutáveis e reaplicação das exclusões antes de restauração. O comando de exclusão deixa explícito que sua ação se limita ao banco ativo. Veja o [procedimento](../architecture/lead-deletion-runbook.md).

Contrato JSON, IDs UUID e timestamps UTC permitem futura importação na API WhiteOven. Essa migração não está implementada. Nenhum fornecedor ou infraestrutura externa foi configurado.

## Referências técnicas

- [Astro: on-demand rendering](https://v5.docs.astro.build/en/guides/on-demand-rendering/).
- [Adapter Node](https://docs.astro.build/en/guides/integrations-guide/node/).
- [Node 24 SQLite](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html).
