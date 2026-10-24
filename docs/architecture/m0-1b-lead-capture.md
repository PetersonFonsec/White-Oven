# M0.1-B — Captação, operação e métricas

> Registro da M0.1-B. A M0.2 prepara imagem, Compose, Caddy de exemplo e saúde/operação; veja o [runbook atual](../operations/landing-deployment.md). As restrições de deploy abaixo descrevem o escopo original.

## Implementado

Homepage pré-renderizada e visual aprovado preservado; formulário com validação cliente/servidor, plano CTA, consentimento explícito, loading, erro/retry e sucesso após commit. `/api/leads`: GET retorna apenas disponibilidade/versão; POST recebe JSON e retorna ID/data, nunca dados enviados. Outros métodos falham. Nenhuma rota lista dados.

Contrato em `packages/contracts`: UUID, nomes limitados a 100/150 caracteres, WhatsApp brasileiro normalizado `+55`, volume/plano em enums, consentimento verdadeiro e versão vigente. Validação de número verifica formato e DDD, não comprova posse ou existência de conta WhatsApp. Campos inesperados, HTML/controles e versões antigas são rejeitados. Atribuição tem cinco UTMs opcionais de até 100 caracteres, referrer reduzido a origem HTTP(S) e landingPath `/`. Não colocar PII nos parâmetros de campanha. Só a visita atual é considerada; sem cookies, armazenamento do browser ou atribuição entre sessões.

Payload é limitado a 8 KiB durante leitura, JSON UTF-8 válido, mesma origem configurada, UUID de idempotência e honeypot vazio. Sem logs de payload, WhatsApp, SQL ou stack nas respostas. Consultas parametrizadas; conteúdo mostrado via escaping Astro/textContent. Limite por cliente de 10 tentativas/10 minutos, seguido de orçamento global de emergência de 600. Apenas um digest HMAC do endereço de conexão fica em memória por dez minutos, sem armazenamento no lead. Leitura total de 5s, concorrência de duas leituras por cliente e 16 no processo: veja limites no ADR. O proxy futuro deverá limitar tamanho, duração da leitura de requisições e conexões lentas, além de não registrar corpos ou query strings sensíveis.

## Ambiente e armazenamento

`apps/landing/.env.example` documenta todas as variáveis. Scripts dev/start/CLI carregam `.env` nessa pasta; variáveis de processo prevalecem. Nenhuma delas é `PUBLIC_` nem colocada no bundle. O endpoint revela apenas disponibilidade e versão; `/privacidade` publica a identidade e contato autorizados, não configuração operacional.

| Variável                | Uso                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `LEADS_ENABLED`         | Somente `true` ativa envio; padrão desativado.                                                                   |
| `SITE_ORIGIN`           | Origem exata sem barra final; HTTPS público, HTTP apenas loopback.                                               |
| `LEADS_CONTROLLER_NAME` | Nome/razão social real do controlador, sem placeholders.                                                         |
| `LEADS_PRIVACY_EMAIL`   | Contato real publicado na política.                                                                              |
| `LEADS_DB_PATH`         | Caminho SQLite. Local: `.data/leads.dev.sqlite` relativo à pasta app. Obrigatório em produção.                   |
| `LEADS_TRUSTED_PROXIES` | IPs exatos do último proxy confiável, separados por vírgula; obrigatório para origem pública. Sem CIDR/wildcard. |
| `HOST`, `PORT`          | Escuta do standalone; padrão seguro de exemplo 127.0.0.1:4321.                                                   |

A identificação e o e-mail reais foram fornecidos pelo Product Owner para configuração; nenhum ambiente de produção foi configurado. Ausência/configuração inválida mantém captação desativada. Para experimentar localmente, preencha a identidade real autorizada ou use uma identidade explicitamente sintética em localhost e apenas cadastros de teste. Não publique fixtures de teste como identidade real.

SQLite é criado sob diretório restrito 0700; diretório existente com acesso de grupo/outros é rejeitado. Banco 0600, arquivos auxiliares permanecem sob esse diretório. O endpoint abre o banco só no primeiro POST válido. Uma resposta de erro nunca deve ser interpretada como cadastro confirmado; no timeout o navegador mantém campos e chave para repetir sem duplicar. Mudança dos dados gera nova chave. Retry após 24 horas já está fora da garantia de idempotência.

## Inspeção, exportação e limpeza

Comandos na raiz usam o mesmo `.env`/banco do app:

```sh
pnpm leads inspect
pnpm leads export .data/lead-exports/leads.json
pnpm leads delete UUID_DO_CADASTRO
pnpm leads purge
pnpm leads clear-dev --confirm
```

`inspect` limita stdout a IDs, datas, plano e volume. `export` grava JSON completo em arquivo novo 0600 dentro de `lead-exports/`, sem imprimir PII; diretório deve permanecer restrito. Esses arquivos são ignorados pelo Git e contêm dados pessoais: mantenha acesso autorizado, transporte protegido e apague cópias quando cessar a finalidade. Não anexe exports a PRs/issues. `delete` remove somente cadastro/chaves do banco ativo e avisa que cópias secundárias exigem ação. Siga o [procedimento rastreável de exclusão](lead-deletion-runbook.md) antes de encerrar a solicitação; `clear-dev` exige confirmação, nome `leads.dev.sqlite` e ambiente não produção. Não executar clear em dados reais.

Expiração em 180 dias: purge é executado em escrita/export/inspect e também existe comando explícito. Antes de publicar, agendar `pnpm leads purge` diariamente com mesmo ambiente/caminho e monitorar falhas; não há scheduler criado nesta milestone. O prazo de 180 dias e a eliminação antecipada precisam abranger cópias exportadas/backups. Faça backups consistentes com SQLite (API backup ou snapshot com servidor parado), cifrados e com controle de acesso; copiar só o arquivo principal enquanto WAL está ativo pode perder dados. Testar restauração é tarefa operacional futura.

## Privacidade

`/privacidade` descreve campos, finalidade de contato/validação, ausência de contratação, retenção, direitos e canal do controlador. Checkbox não vem marcado. Cadastro registra texto/versão, data, controlador/contato e prazo vigentes. O hash de idempotência e a deduplicação incluem o snapshot completo da política em ordem fixa. Mudanças geram conflito para a mesma chave e nunca reutilizam consentimento antigo com uma nova chave. Mudanças materiais precisam nova versão de consentimento/política; não alterar o texto mantendo a versão. A aplicação não envia contatos automáticos, mensagens ou e-mails.

Atendimento de acesso/correção/revogação/exclusão é manual pelo controlador. Exportação restrita serve para localizar o registro; a exclusão usa UUID. Correção nesta etapa pode ser atendida por exclusão e novo envio autorizado. Não há portal de titulares nem promessa de certificação jurídica. Revisar tratamento e operação antes da publicação segundo [orientações da ANPD](https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados/direito-dos-titulares).

## Analytics e cálculo futuro

Adaptador `src/scripts/analytics.ts`: `track` restringe evento a oito nomes, aceita somente plano enum e ID aleatório efêmero por carregamento; não aceita campos livres. Default: `CustomEvent('whiteoven:analytics')` local. Não transmite nem persiste; `setAnalyticsAdapter(null)` desabilita e falha do adaptador não afeta formulário. Nenhum fornecedor aprovado/integrado. Não envie corpo do formulário, leadId, URL, referrer, UTMs ou dados pessoais ao futuro adaptador.

Eventos: `landing_view` ao carregar; `pizza_builder_interaction` nas alterações; `pricing_view` na primeira visualização; `plan_interest_click` no CTA; `lead_form_started` na primeira edição; `lead_form_submitted` em tentativa válida; `lead_form_success` após confirmação; `lead_form_error` na falha. Contagem de tentativas não equivale a leads únicos. ID aleatório de página não identifica pessoa ou visita recorrente.

| Pergunta            | Cálculo futuro / disponível agora                                                                                 |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Visitantes → início | Páginas com `lead_form_started` / `landing_view`, após aprovação de coleta de eventos. Não conta pessoas únicas.  |
| Início → enviado    | Páginas com sucesso / páginas com início; submitted mede tentativa.                                               |
| Conversão total     | Páginas com sucesso / páginas visualizadas; definir dedup de retry antes de divulgar indicador.                   |
| Flex vs Pro         | Leads agrupados por interestedPlan; UNDECIDED separado. Disponível via export.                                    |
| Volume              | Leads por monthlyOrderVolume. Disponível via export.                                                              |
| Origem              | Leads por UTMs, nulos como direto/desconhecido; referrer é só domínio. Disponível via export.                     |
| Builder → conversão | Eventos por pageId fornecem denominador futuro; funnel.pizzaBuilderInteracted informa numerador nos leads atuais. |
| CTA → conversão     | Eventos por pageId fornecem denominador futuro; funnel.planCtaClicked e plano informam leads atuais.              |

Hoje **não há denominador persistido de visitas/inícios**, portanto não podemos afirmar taxas de conversão reais. Efeito causal do Builder/CTA não é demonstrado por esses indicadores. Aprovação, retenção e avaliação de privacidade precedem conexão de analytics externo. Nenhum dashboard foi criado.

## Verificação e produção futura

`pnpm check`, `pnpm test`, `pnpm build`, `pnpm test:e2e`. Testes Node usam SQLite real temporário; E2E usa `.data/leads.e2e.sqlite`, identidade sintética e sem credenciais, com dados diferentes por caso. Cobrem salvamento, retry, ausência de sucesso antes da resposta, atribuição, consentimento, planos e eventos sem PII. Testes originais de Builder, preço, menu e responsividade permanecem; somente as expectativas do formulário protótipo foram substituídas.

Antes de publicação: configurar identidade/contato autorizados, ativação, origem HTTPS real, caminho absoluto em volume persistente e Node compatível; reverse proxy dedicado; diretório restrito; backup e purge diário; revisão da política e de logs; acesso de operador e tratamento dos direitos; monitorar disponibilidade e abuso. Servir por `pnpm start`, que envolve o handler standalone Astro com o limite HTTP e contexto confiável de cliente. Não executar diretamente `dist/server/entry.mjs` em produção. Não configurar Caddy/Hostinger/Orbia, deploy ou agendamentos nesta PR. Não há API principal NestJS, PostgreSQL SaaS, painel, mobile, autenticação, pagamentos, CRM ou M1.

## Fronteira HTTP e publicação futura

`LEADS_TRUSTED_PROXIES` recebe IPs exatos de conexões do último proxy ao Node. Vazio ignora headers encaminhados e usa o socket, adequado a localhost. Para origem pública a lista precisa estar preenchida; lista inválida impede a inicialização. O proxy deve **substituir** `X-Forwarded-For` por um único IP derivado da conexão verificada, nunca repassar um valor fornecido pelo visitante nem anexar cadeia. Proxy com header ausente, inválido ou com múltiplos IPs recebe 403. Bind Node em loopback/rede privada, bloqueando acesso público direto. Não confie em `0.0.0.0/0`, redes inteiras ou wildcard. Em `pnpm dev` sem inicializador, todos compartilham um bucket de desenvolvimento e headers do visitante são ignorados; isso não é modo de produção.

O artefato de execução inclui `dist`, dependências instaladas para o Node/plataforma alvo, `scripts/serve.mjs` e `src/server/http-server.ts`/`request-context.ts`. O inicializador usa o suporte de strip de TypeScript do Node definido nos requisitos; copiar apenas `dist` não inclui a fronteira HTTP. `pnpm start` assume `NODE_ENV=production` quando não definido.

`pnpm start` mantém o servidor estático do adapter, mas configura 128 conexões simultâneas, headers de até 8 KiB/5s, requestTimeout 7s, timeout de inatividade 8s e keep-alive 5s. As verificações periódicas HTTP são de 1s; limites de transporte podem encerrar a conexão sem JSON. O endpoint tem deadline absoluto de leitura de 5s (não reinicia a cada bloco), limite de 8 KiB e vagas de leitura por cliente/processo. Timeout retorna 408 quando a conexão ainda permite resposta, cancela a leitura e libera capacidade, sem persistir dados. Origem pública sem proxy configurado e build servido sem o contexto do inicializador ficam indisponíveis para captação.

Checklist obrigatório antes de ativar no proxy real: confirmar socket do último proxy e lista exata; tentar forjar `X-Forwarded-For` a partir de cliente não confiável; confirmar substituição de headers; testar dois clientes reais (esgotar um não bloqueia o outro); enviar corpo lento, corpo acima do limite e headers lentos; confirmar rejeição, liberação de capacidade e ausência de PII em logs. Configurar proteção equivalente no proxy/borda sem instalar terceiros silenciosamente. E2E usa o inicializador real; testes de servidor verificam isolamento, spoofing e limites. A VPS e o proxy de produção não foram acessados, portanto esse checklist continua pendente nesse ambiente.
