# M0.1-A — Landing de validação comercial

> Registro histórico da M0.1-A. O formulário e o build foram evoluídos na [M0.1-B](m0-1b-lead-capture.md); as capturas preservam a revisão visual anterior.

## Implementação

Componentes Astro separados para header, footer, botões, títulos, benefícios, planos, badges, formulário e Builder. Prévias de aplicativo e painel usam marca e dados fictícios identificados como ilustrativos. Sem React, backend ou analytics. Playwright e tipos do Node são dependências somente de desenvolvimento para testes reproduzíveis. O build permanece estático.

O Pizza Builder usa uma base fotográfica gerada para o projeto e SVG próprio com grupos de ingredientes por sabor e clip paths para cada metade. Os quatro sabores têm representações próprias: calabresa/cebola, tomate/manjericão, frango/catupiry e quatro queijos. Cada instância recebe IDs exclusivos. Alterar a seleção atualiza grupos, descrição acessível e preço. A pizza inteira usa o sabor esquerdo; a escolha direita é preservada em memória para retornar ao meio a meio.

Preços são inteiros em centavos; no meio a meio vale o maior preço, sem média ou soma. `Intl.NumberFormat` apresenta BRL. São valores fictícios, sem checkout, pedidos ou pagamentos.

## Formulário e privacidade

Os CTAs dos planos preenchem a seleção no formulário via JavaScript. O formulário não representa inscrição real: botão de envio desabilitado, ausência de endpoint e nomes de campos para submissão, e prevenção de submit por JavaScript. Não usa `method="dialog"`. Um fieldset começa desabilitado e só é liberado depois da instalação do bloqueio de submissão; sem JavaScript, os campos ficam desabilitados com explicação visível. Não há POST nesta milestone. Nenhuma requisição, log, cookie ou armazenamento de informações pessoais é implementado. O consentimento não é registrado. Autocomplete desativado reduz preenchimento automático pelo navegador, sem garantir políticas de armazenamento do próprio browser.

M0.1-B deverá adicionar o contrato de dados, `method="post"`, endpoint/action, nomes dos campos, validação, política de privacidade e estados reais de envio, erro e sucesso, após aprovação. A interface de campos e planos pode ser reutilizada. Não basta habilitar o botão do protótipo.

## Lojas e identidade

Badges sem URL renderizam elementos não interativos “Em breve”. `StoreBadge` aceita uma URL HTTPS de loja para integração futura; nenhuma URL foi configurada. O produto é white label: aplicativos próprios de cada pizzaria, sujeitos à aprovação Apple/Google. Não há promessa de publicação automática.

A referência visual e o vídeo foram fornecidos pelo Product Owner em 2026-10-23. A imagem está versionada em `docs/design/whiteoven-visual-reference.png`, com autorização explícita do Product Owner; leitura do vídeo, decisões e capturas atualizadas estão em [docs/design](../design/README.md). A direção foi aplicada com imagens gastronômicas originais geradas para o projeto, superfícies creme/laranja e composição de pizza, aplicativo e gestão. Não foram recortadas fotografias ou copiadas marcas do material. Tokens compartilhados cobrem cores, tipografia, raios, espaço, sombras, breakpoints e interações. A aprovação visual final é do Product Owner.

## Verificações

`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build` e `pnpm test` passaram. O typecheck retornou zero erros, avisos e hints. Seis testes nativos do Node verificam todas as 16 combinações de preço, preço de pizza inteira, seleção sem mutação, preservação do segundo sabor, rejeição de sabor inválido e descrições acessíveis/BRL. A CI agora inclui `pnpm test`.

A verificação anterior no navegador era uma automação pontual não versionada; não era uma suíte de integração reproduzível do repositório. Agora `playwright.config.ts` e `apps/landing/tests/e2e/landing.spec.ts` versionam os testes do build estático com Playwright: transição inteira ↔ meio a meio, grupos de ingredientes SVG/clip paths e preço, planos, bloqueio de submissão, ausência de persistência/requisições externas, menu mobile/Escape, fallback sem JavaScript, movimento reduzido e ausência de overflow em 320/375/768/1024/1440px.

São 11 execuções aplicáveis entre desktop e mobile; a de menu mobile é ignorada no projeto desktop. `pnpm test` continua rodando somente os 6 testes de domínio; `pnpm test:e2e` gera o build e executa os testes de integração. A CI executa ambos e publica traces/screenshots de falhas. Capturas para revisão humana e reprodução estão em [docs/design](../design/README.md); não são testes de comparação de pixels.

Contraste calculado: carvão/branco 15,33:1; texto secundário/creme 5,45:1; carvão/laranja 6,86:1; carvão/hover 5,24:1; texto de destaque/creme 6,20:1; borda de campo/branco 3,81:1. A revisão não substitui auditoria WCAG completa com leitores de tela nem testes em aparelhos iOS/Android reais.

## Limites

Prévia conceitual do produto, preços preliminares e formulário não operacional. Não há API, autenticação, banco, captação, aplicação Angular/React Native, checkout, pagamentos ou deploy. M0.1-B depende de aprovação.
