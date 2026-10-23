# M0.1-A — Landing de validação comercial

## Implementação

Componentes Astro separados para header, footer, botões, títulos, benefícios, planos, badges, formulário e Builder. Prévias de aplicativo e painel usam marca e dados fictícios identificados como ilustrativos. Sem React, backend, analytics ou dependências novas. O build permanece estático.

O Pizza Builder usa SVG original com grupos de ingredientes por sabor e clip paths para cada metade. Os quatro sabores têm representações próprias: calabresa/cebola, tomate/manjericão, frango/catupiry e quatro queijos. Cada instância recebe IDs exclusivos. Alterar a seleção atualiza grupos, descrição acessível e preço. A pizza inteira usa o sabor esquerdo; a escolha direita é preservada em memória para retornar ao meio a meio.

Preços são inteiros em centavos; no meio a meio vale o maior preço, sem média ou soma. `Intl.NumberFormat` apresenta BRL. São valores fictícios, sem checkout, pedidos ou pagamentos.

## Formulário e privacidade

Os CTAs dos planos preenchem a seleção no formulário via JavaScript. O formulário não representa inscrição real: botão de envio desabilitado, método `dialog` sem um diálogo associado (que não faz submissão HTTP), ausência de nomes de campos para submissão e prevenção de submit por JavaScript. Nenhuma requisição, log, cookie ou armazenamento de informações pessoais é implementado. O consentimento não é registrado. Autocomplete desativado reduz preenchimento automático pelo navegador, sem garantir políticas de armazenamento do próprio browser.

M0.1-B deverá adicionar o contrato de dados, endpoint, validação, política de privacidade e estados reais de envio, erro e sucesso, após aprovação. A interface de campos e planos pode ser reutilizada. Não basta habilitar o botão do protótipo.

## Lojas e identidade

Badges sem URL renderizam elementos não interativos “Em breve”. `StoreBadge` aceita uma URL HTTPS de loja para integração futura; nenhuma URL foi configurada. O produto é white label: aplicativos próprios de cada pizzaria, sujeitos à aprovação Apple/Google. Não há promessa de publicação automática.

A referência visual não estava no repositório. Em seu lugar, a direção textual orientou uma composição food-tech premium com SVGs originais, sem imagens externas com licença desconhecida. Fotografias não foram incluídas por ausência de assets autorizados. Tokens compartilhados cobrem cores, tipografia, raios, espaço, sombras, breakpoints e interações.

## Verificações

`pnpm install --frozen-lockfile`, `pnpm lint`, `pnpm typecheck`, `pnpm build` e `pnpm test` passaram. O typecheck retornou zero erros, avisos e hints. Seis testes nativos do Node verificam todas as 16 combinações de preço, preço de pizza inteira, seleção sem mutação, preservação do segundo sabor, rejeição de sabor inválido e descrições acessíveis/BRL. A CI agora inclui `pnpm test`.

Revisão por Chrome headless com Playwright já disponível no ambiente, sem dependência nova no projeto: sabores, preço, modos, CTA de ambos os planos, formulário sem envio, ausência de links falsos, ausência de armazenamento e requisições externas, menu mobile/Escape, foco do atalho para conteúdo, preferência por movimento reduzido e fallback sem JavaScript. Sem erros de console na sessão. Larguras 320, 375, 768, 1024 e 1440px sem overflow horizontal. Screenshots desktop/mobile inspecionados.

Contraste calculado: carvão/branco 15,33:1; texto secundário/creme 5,45:1; carvão/laranja 6,86:1; carvão/hover 5,24:1; texto de destaque/creme 6,20:1; borda de campo/branco 3,81:1. A revisão não substitui auditoria WCAG completa com leitores de tela nem testes em aparelhos iOS/Android reais.

## Limites

Prévia conceitual do produto, preços preliminares e formulário não operacional. Não há API, autenticação, banco, captação, aplicação Angular/React Native, checkout, pagamentos ou deploy. M0.1-B depende de aprovação.
