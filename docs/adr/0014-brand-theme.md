# ADR 0014: tema de marca da loja

- **Status:** implementado em M3.5
- **Data:** 2026-10-26
- **Milestone:** M3.5

## Contexto

O [modelo de domínio](../architecture/domain-model.md#brandtheme) define `BrandTheme`. O [design system](../architecture/design-system.md#consumo-futuro-e-white-label) pede overrides restritos aos tokens de marca, sem tocar nos tokens de acessibilidade e feedback, e validação de contraste antes de aceitar um tema. O critério de aceite do M3.5 é que um tema com contraste insuficiente não seja publicado e que os tokens de acessibilidade não possam ser sobrescritos. O app que vai usar o tema só chega em M5.1.

## Decisão

- **Tabela `brand_themes`**, uma linha por loja, com RLS forçada. Ela guarda:
  - `color_overrides` (JSON), com só os tokens alterados;
  - `logo_asset_id` e `icon_asset_id`, com FK composta `(tenant_id, id)` para `image_assets`, então uma loja não referencia imagem de outra;
  - `version`, que começa em 1 e sobe a cada gravação.
- **Tokens editáveis:** `primary`, `primaryHover`, `primaryPressed`, `onPrimary` e `accentText`. Qualquer outra chave é recusada com `BRAND_TOKEN_LOCKED` na API, e uma restrição `check` do banco recusa a mesma coisa. Os padrões são os de `packages/design-tokens/tokens.json`; um teste da API garante que as cópias são iguais.
- **Contraste (WCAG 2.2, mínimo 4,5:1 para texto):**
  - `onPrimary` sobre `primary`, `primaryHover` e `primaryPressed`, que é o texto dos botões;
  - `accentText` sobre `surface` e sobre `cream`, que são os textos de destaque.
  - O indicador de foco não entra nos pares: ele usa a cor fixa do WhiteOven e é desenhado com afastamento sobre as superfícies, que a loja não altera. Exigir 3:1 entre foco e `primary` recusaria toda cor principal escura.
- **Publicar é gravar.** Não há rascunho no servidor. `PUT /v1/admin/store/brand` valida tudo e só grava um tema que passa. A recusa é `422 BRAND_THEME_INVALID` com `details.errors`. Uma falha de contraste traz `path` (`contrast.onPrimary/primary`), `ratio` (arredondado para baixo) e `minimum`.
- **Imagens:** são enviadas pela rota de imagens já existente ([ADR 0010](0010-image-storage.md)). A loja referencia o id da imagem. A API confere se a imagem é da loja (`BRAND_IMAGE_NOT_FOUND`) e o tamanho:
  - o logotipo precisa de ao menos 256 px no lado maior;
  - o ícone precisa ser quadrado e ter ao menos 512 px de lado.
  - O ícone e o splash do binário de cada loja continuam sendo da build (manifesto, M5.6).
- **Regras e cálculo:** as regras ficam em `apps/api/src/store/brand-rules.ts`, pelo mesmo motivo do ADR 0013 (a API ainda não consome pacotes ESM). `GET /v1/admin/store/brand` devolve os pares de contraste, as cores fixas e os limites de imagem. O painel calcula a razão com a fórmula padrão da WCAG só para a prévia enquanto a pessoa digita, sem copiar a lista de pares.
- **Papéis e auditoria:** só o OWNER publica, pela capacidade `storeSettingsWrite`; o MANAGER lê. Uma loja suspensa não grava. O trigger de auditoria das configurações (`whiteoven_store_audit_change`) passa a cobrir `brand_themes`, com a ação `store.brand.updated`, e recusa no banco quem não for OWNER.
- **Painel:**
  - A página `/loja/marca` é só do OWNER.
  - Cores: cada token tem seletor e campo `#RRGGBB`, com o botão "Usar padrão".
  - A lista de contraste se atualiza ao vivo e mostra a razão, o mínimo e o texto "atende" ou "insuficiente", sem depender só de cor.
  - Logotipo e ícone podem ser enviados e removidos.
  - A prévia do app mostra o topo com o logotipo, um card com preço e botões nos três estados, e o ícone.
  - "Publicar marca" fica desabilitado enquanto um par falha ou uma cor está mal formada.

## Alternativas descartadas

- **Rascunho e publicação separados:** davam mais controle, mas criavam dois estados para o app e para a auditoria. Com um único tema, a prévia do painel já cumpre o papel do rascunho.
- **Corrigir as cores automaticamente** (escurecer até passar): mudaria a marca sem a pessoa decidir. A API recusa e o painel mostra o que falta.
- **Ligar `packages/design-tokens` à API:** exigiria mudar o Dockerfile da API. O teste de igualdade com `tokens.json` evita que as cópias divirjam.

## Consequências

- O endpoint público de marca (`/v1/public/stores/{slug}`), fontes (`fontFamily`) e splash ficam para M5.1 e M5.6, quando o app existir. `version` já está pronto para invalidar o cache do app.
- Um tenant só passa a `ACTIVE` com tema válido (domain-model). Todo tema gravado já é válido. A verificação na ativação entra quando a ativação passar a exigir os pré-requisitos.
- A imagem escolhida para logotipo e ícone fica no mesmo storage das imagens do cardápio, com as mesmas variantes WebP.
