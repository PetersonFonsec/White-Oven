# ADR 0030: termos, política de privacidade e exclusão de conta pela web

- **Status:** implementado em M7.2, aguardando o texto do jurídico
- **Data:** 2026-10-31
- **Milestone:** M7.2

## Contexto

O critério de aceite da M7.2 pede a versão aceita registrada e a exclusão de conta disponível no app. Até aqui:

- o cadastro gravava em `customers.privacy_policy_version` a versão que o app dizia ter mostrado, sem que a API soubesse quais versões existiam (ADR 0017);
- o texto ficava no manifesto de cada loja, embutido no binário, e só existia um aviso demonstrativo (ADR 0022). A trava de build de loja recusava esse aviso (ADR 0028);
- a exclusão de conta já existia em Minha conta (`DELETE me`, ADR 0017), mas o Google Play exige também um endereço na web para pedir a exclusão sem o app, e as duas lojas pedem a URL da política de privacidade (`docs/operations/mobile-publishing.md`).

Cada pizzaria é a controladora dos dados dos seus clientes, e o WhiteOven é o operador. Os textos (termos de uso e política de privacidade de cada pizzaria, e o contrato de operador entre o WhiteOven e a pizzaria) vêm do jurídico e ainda não existem. Esta decisão entrega o mecanismo para publicar, mostrar e registrar o aceite desses textos, sem escrever nenhum deles.

## Decisão

### Documentos por loja, versionados na API

- Tabela de tenant `legal_documents`: um registro por versão publicada, com `kind` (`PRIVACY_POLICY` ou `TERMS_OF_USE`), `version` (`^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$`), `revision` (1, 2, … por loja e tipo), o texto, o SHA-256 do texto, quem publicou e quando. O documento vigente é a maior `revision`. RLS forçada como toda tabela de tenant (ADR 0006).
- **Só para frente:** um gatilho recusa `UPDATE` e `DELETE` até para o dono das tabelas. O texto que um cliente aceitou pode sempre ser mostrado de novo.
- **Publicação:** só pela função `whiteoven_publish_legal_document`, com sessão de operador com MFA, sob o lock da linha do tenant (duas publicações nunca pegam a mesma `revision`), e com evento de auditoria `legal_document.published` que guarda o hash, nunca o texto. Publicar de novo a mesma versão com o mesmo texto não muda nada (retry seguro); a mesma versão com outro texto responde `409 LEGAL_VERSION_CONFLICT`, porque um nome de versão sempre quer dizer um texto. Loja `CLOSED` não recebe publicação.
- **Leitura pelo operador:** `whiteoven_platform_legal_documents` lista todas as versões de uma loja. Como as funções de plataforma da M1, ela troca `app.tenant_id` com `set_config(..., true)` (vale só até o fim da transação) e devolve o valor anterior depois do `RETURN QUERY`, que já materializou as linhas. Se der erro no meio, o rollback (da transação ou do savepoint) desfaz a troca, e uma conexão reaproveitada começa sem tenant. `legal.test.ts` cobre esses casos numa conexão única: lojas A e B em sequência, contexto de quem chamou, erros antes e depois da troca e sessões sem MFA.
- Rotas de operador: `GET` e `POST /v1/platform/tenants/{tenantId}/legal-documents` (`201` para versão nova, `200` para repetição).
- **Formato do texto:** texto simples, blocos separados por linha em branco, `## ` para título e `- ` para item de lista (`legalBlocks` em `@whiteoven/contracts`). Nenhum HTML vem do banco: o app e as páginas web escapam tudo o que mostram.

### Aceite registrado

- Tabela de tenant `customer_legal_acceptances`: cliente, documento (a versão exata) e data. O papel da API só insere e lê; um gatilho impede alteração e exclusão.
- **Cadastro:** o corpo passa a exigir `privacyPolicyVersion` e `termsOfUseVersion`. A API confere, na mesma transação do cadastro, que são as versões vigentes e grava o aceite dos dois documentos. Versão diferente da vigente responde `409 LEGAL_VERSION_OUTDATED` com as versões atuais em `details`; loja sem os dois documentos responde `409 LEGAL_DOCUMENTS_UNAVAILABLE`, e o cadastro fica fechado.
- **Nova versão:** `GET me` informa `termsOfUseVersion` e `legalUpdateRequired` (há documento vigente que o cliente não aceitou). `POST me/legal-acceptances` registra o aceite das versões vigentes, com as mesmas regras do cadastro, e é idempotente. Neste marco a nova versão **não bloqueia** pedidos: o app mostra o aviso e o botão de aceite em Minha conta. Se o jurídico exigir novo aceite antes de pedir, isso vira uma regra no pedido (ver Pendências).
- `customers.privacy_policy_version` e `accepted_at` guardam o aceite do cadastro e não mudam depois (como na M4.2). Um novo aceite só acrescenta linhas em `customer_legal_acceptances`, cada uma com a própria data; repetir um aceite não altera nada. Em `GET me`, `acceptedAt` continua sendo a data do primeiro aceite, e `privacyPolicyVersion` passa a ser a última versão aceita (para contas anteriores à M7.2 que ainda não aceitaram um documento publicado, a versão do cadastro).

### Exclusão de conta

- O aceite **fica** depois da exclusão: guarda só ids e data, e é o registro do consentimento dado enquanto a conta existia. A anonimização da ADR 0017 não muda. `ops/postgres/reapply-customer-erasures.sql` e `backup-erasures.test.ts` registram isso (a lista de tabelas que apontam para `customers` inclui a nova).
- A remoção de dados foi extraída para uma função `erase` usada pelos dois caminhos, app e web, com o mesmo lock do cliente e a mesma condição (conta `ACTIVE` com o hash de senha conferido).
- A exclusão não apaga tudo, e as telas dizem isso. **Apaga:** nome, e-mail, telefone e senha da conta; endereços salvos; aparelhos de push; nome, telefone, endereço de entrega e observações nos pedidos. As sessões são revogadas. **Fica:** a linha de `customers` sem dados de contato (id, datas de criação e exclusão, versão e data do aceite do cadastro); os pedidos com itens, valores, datas e histórico, ligados ao id interno; os aceites; as sessões revogadas e os registros de entrega de push (só ids e datas); a linha de `customer_erasures` (ADR 0029); o texto livre que a loja escreveu em ocorrências e motivos de pedido (ADR 0019); os backups anteriores, até serem substituídos. A página `/excluir-conta` e o app listam isso sem citar base legal nem prazo, que cabem à política de privacidade de cada loja. A lista fica em `legal-pages.ts` e precisa mudar junto com `erase` e `reapply-customer-erasures.sql`.

### Páginas web da loja, servidas pela API

Fora do prefixo `/v1`, para que a URL caiba nas fichas das lojas:

- `GET /lojas/{slug}/privacidade` e `GET /lojas/{slug}/termos`: o documento vigente, com versão e data; `404` enquanto não houver.
- `GET /lojas/{slug}/excluir-conta`: explica o que é excluído e o que fica, e traz um formulário de e-mail, senha e confirmação. `POST` exclui a conta com a mesma anonimização do app.
- O formulário não revela conta: e-mail desconhecido, senha errada, conta já excluída e conta de outra loja recebem a mesma resposta (`401`). Usa o mesmo bloqueio progressivo do login do cliente e conta as falhas no mesmo contador. Sem JavaScript.
- Leitura em qualquer status da loja (nova capacidade `legalRead`): o cliente mantém seus direitos depois de suspensão ou encerramento, e as fichas precisam das URLs antes de a loja entrar no ar. A exclusão segue a regra das contas de cliente (`ACTIVE`, `SUSPENDED` ou `CLOSED`); numa loja em `ONBOARDING` não há clientes, e o `POST` responde `403`.
- Cabeçalhos: `Content-Security-Policy` com `default-src 'none'`, a folha de estilo única autorizada pelo hash, `form-action 'self'` e `frame-ancestors 'none'`; `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`; `no-cache` nos documentos e `no-store` na exclusão. Erros dessas rotas são páginas HTML, nunca o corpo JSON da API.
- O corpo `application/x-www-form-urlencoded` da API fica limitado a 4 KiB e sem objetos aninhados. Antes desta decisão o Express aceitava 100 KiB aninhados em qualquer rota.

### App

- O manifesto não tem mais `privacyPolicy`; um manifesto que ainda o tenha é recusado com aviso. O app lê `GET /v1/public/stores/{slug}/legal` sempre que Minha conta abre, mostra os dois textos com o mesmo formato da página web e envia as duas versões no cadastro. Um `409` no cadastro recarrega os textos e desmarca o aceite se a versão mudou.
- Com `legalUpdateRequired`, Minha conta mostra o aviso, os textos atuais e o botão “Li e aceito a versão atual”.
- **Build de loja:** como o texto não está mais no binário, a trava passa a perguntar à API do build. `pnpm mobile:release-check {slug} store --eas` roda dentro do ambiente do EAS e recusa (saída 4) quando a API não serve os dois documentos ou serve texto demonstrativo (versão `demo-`). Sem `--eas`, a mesma conferência roda com a `WHITEOVEN_API_URL` do shell. O `app.config.ts` não consulta a rede.

### Dados de demonstração

O seed de demonstração publica textos `demo-2026-11` que dizem ser só para dados fictícios. As fixtures de teste publicam a versão `2026-10`. Nenhum texto jurídico foi escrito.

## Consequências

- O cadastro fica fechado em toda loja até o operador publicar os dois documentos. Isso vale também para lojas de desenvolvimento criadas antes desta migration.
- Uma correção de texto, mesmo de vírgula, é uma nova versão; a anterior fica disponível para quem a aceitou.
- O app mostra sempre o texto atual da API; não há texto antigo embutido que possa divergir.
- O mesmo número de versão em lojas diferentes são documentos diferentes (D-03).

## Pendências (dependem do jurídico ou do usuário)

1. Texto da política de privacidade e dos termos de uso de cada pizzaria, com prazos de guarda dos pedidos anonimizados, do aceite e dos backups (ADR 0029), e menção ao token de push (ADR 0027) e às ocorrências de pedido.
2. Contrato de operador entre o WhiteOven e cada pizzaria. É assinado fora da plataforma; o checklist de onboarding (M7.5) registra a versão assinada.
3. Se uma nova versão deve bloquear pedidos até o novo aceite.
4. A descrição livre das ocorrências de pedido continua depois da exclusão da conta (ADR 0019). Ou a política informa isso, ou a exclusão passa a apagar o texto: decisão do jurídico.
5. Uma tela no painel do operador para publicar os textos. Hoje a publicação é pela rota de plataforma.
6. Revisar o texto da página de exclusão e da tela Minha conta (o que é apagado e o que fica), e decidir se os pedidos ligados ao id interno contam como dados anonimizados ou pseudonimizados para a LGPD. As telas evitam a palavra "anonimizado" até essa decisão.
7. Base legal e prazo de guarda de cada item que fica depois da exclusão, inclusive dos backups, para a política de privacidade.
