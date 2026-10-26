# ADR 0020: base do app Expo white label

- **Status:** em desenvolvimento em M5.1
- **Data:** 2026-10-26
- **Milestone:** M5.1

## Contexto

O [system-overview](../architecture/system-overview.md#white-label) define o app do cliente: uma base React Native + Expo, um binário por pizzaria e a marca aplicada em runtime. O binário só conhece o `storeSlug`; o resto vem da API e fica em cache para abrir offline.

O critério de aceite do M5.1 tem três partes:

- dois manifestos de exemplo geram apps com nome e ícone diferentes;
- a marca vem da API;
- o app abre offline com a última marca.

A [ADR 0014](0014-brand-theme.md) deixou para M5.1 o endpoint público de marca.

## Decisão

- **Pilha:** `apps/mobile` usa Expo SDK 58, com React Native 0.88 e React 19.3, nas versões do template oficial `blank-typescript` do SDK.
  - As dependências diretas são `expo`, `expo-constants`, `expo-file-system`, `expo-status-bar`, `react` e `react-native`. Nenhuma biblioteca fora do Expo entra.
  - Não há navegação nem estado global: o app tem uma tela até o cardápio (M5.2).
  - Pastas nativas (`ios/`, `android/`) não são versionadas. São geradas por build a partir do manifesto (M5.6).
- **Manifesto por loja** (`apps/mobile/manifests/{slug}.json`), validado por `parseManifest`. Uma chave desconhecida recusa o manifesto. Campos:
  - `slug`, igual ao da API;
  - `name`, o nome na tela inicial e nas lojas;
  - `version`;
  - `ios.bundleIdentifier` e `android.package`;
  - `icon`, um PNG quadrado em `assets/tenants/{slug}/`, que também serve de ícone adaptativo do Android sobre `iconBackgroundColor`;
  - `fallbackColors`, as cores até a primeira resposta da API. Os tokens omitidos ficam com o padrão WhiteOven, e as cores passam pelos mesmos pares de contraste da ADR 0014.
- **`app.config.ts`:**
  - Escolhe o manifesto por `WHITEOVEN_TENANT` e a API por `WHITEOVEN_API_URL`.
  - A API precisa de HTTPS. HTTP só é aceito para `localhost`, `127.0.0.1` ou `10.0.2.2`, o emulador Android na máquina de quem desenvolve.
  - O config embute em `extra.whiteoven` só o slug, o nome, a URL da API e as cores de fallback, sem nenhum segredo.
  - Splash e telas de loja ficam para o pipeline de build (M5.6), como na ADR 0014.
- **API:** `GET /v1/public/stores/{slug}` devolve `{ slug, name, brand: { version, colors } }`.
  - As cores já vêm resolvidas sobre os padrões. O endpoint usa a mesma capacidade `publicMenu` do cardápio: loja `ACTIVE`; outra loja recebe `403 TENANT_NOT_ACTIVE`; slug desconhecido recebe `404`.
  - O cabeçalho é `Cache-Control: no-cache`, para que um tema novo ou uma suspensão apareçam na próxima abertura.
  - Nenhum id de imagem é exposto. O logotipo entra com a rota pública de imagens do cardápio em M5.2, para que as duas compartilhem a mesma política de cache e de autorização.
- **Carregamento** (`loadStore`, puro e testado com `fetch` e cache em memória):
  - Pede o perfil e o status (`/status`, ADR 0016) em paralelo, com tempo-limite de 8 s.
  - Um perfil válido e da própria loja substitui o cache e aparece na hora. Um perfil de outra loja ou com cores que falham o contraste é descartado.
  - Sem resposta (rede, tempo-limite, 5xx ou 429), o app usa a última marca em cache ou, sem cache, a do manifesto, e mostra o aviso de sem conexão.
  - `403` e `404` mostram "Pizzaria indisponível", mantendo a última marca.
  - O status nunca vai para o cache: um "aberta" antigo poderia levar um pedido a uma loja fechada.
- **Cache:** um arquivo JSON por loja no diretório de documentos do app (`expo-file-system`), com versão de formato e no máximo 16 KiB.
  - Guarda só o perfil público. Token e dado pessoal nunca vão para esse arquivo; o refresh token do cliente (M5.3) irá para `expo-secure-store`.
  - Um cache quebrado ou de outra loja é ignorado.
  - O primeiro quadro já usa a marca do cache, antes de a API responder.
- **Telas:**
  - Loja aberta, com o nome e a marca.
  - "Loja fechada", com o fim da pausa no fuso da loja ou "fora do horário".
  - "Pizzaria indisponível".
  - Aviso de sem conexão.
  - O texto acompanha o tamanho de fonte do sistema, os alvos de toque têm 48 dp e os papéis de acessibilidade estão declarados (`header`, `button`, `alert`).
- **Testes:** a lógica fica em módulos sem React Native e roda com `node --test` (`pnpm test`).
  - Os testes geram o config dos dois manifestos e conferem nomes, ícones e ids diferentes.
  - Também cobrem a validação do manifesto e da URL e os cenários de cache e offline.
  - `expo export` gera o bundle localmente, mas a CI não exporta: a ADR de build (M5.6) decide o pipeline.

## Alternativas descartadas

- **AsyncStorage para o cache:** é uma dependência a mais, e o `expo-file-system` já faz parte do SDK. O dado é público.
- **Testes de componente com `jest-expo`:** trazem Jest e um preset para três componentes simples. A lógica que decide a tela é pura e testada. Testes de interface entram quando houver fluxo (M5.2–M5.3).
- **Cores só do manifesto, sem API:** cada troca de marca exigiria um build e uma revisão nas lojas, o oposto do tema em runtime decidido em D-08.
- **Um endpoint com perfil e status juntos:** o status muda a cada minuto e não pode ir para cache; o perfil pode. Separados, cada um tem sua política.

## Consequências

- Uma loja nova no app precisa de manifesto e ícone no repositório. A automação do build fica para M5.6.
- O nome dentro do app vem da API (`tenants.display_name`). O nome sob o ícone é o do manifesto e só muda com outro build.
- O ícone e as cores de fallback são da build. Uma marca nova aparece pela API, sem build.
