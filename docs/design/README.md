# Referência visual e revisão da landing

## Dependência do Product Owner — pendente

**Por favor, forneça a referência aprovada em `docs/design/whiteoven-visual-reference.png`.** O arquivo não existe no repositório na revisão de 2026-10-23. Não foi criado um placeholder com esse nome para evitar confundi-lo com o asset real.

A validação de fidelidade à referência e a aprovação final do item P1 permanecem pendentes até o recebimento desse arquivo. Informe também as restrições de uso e os assets gastronômicos autorizados, se existirem. Nenhuma fotografia externa foi introduzida.

## O que foi refinado nesta revisão

- Hero com hierarquia em carvão e destaque laranja, com maior separação entre conteúdo e composição visual.
- Pizza original com acabamento de borda assada, queijo e ervas, sobre prato claro com sombra discreta. Continua sendo ilustração; não é fotografia nem reprodução da referência.
- Mockup de aplicativo maior e menos inclinado no desktop, categorias visuais e combinação de sabores identificada, sempre com indicação de prévia ilustrativa.
- Retirada a legenda que sobrepunha a base do telefone. A prévia continua sendo um link funcional para a demonstração.
- Flex destaca **3% por venda paga**, com **sem mensalidade** como benefício. Pro destaca **R$ 199/mês** e **0% de comissão WhiteOven**.

Essas são melhorias baseadas na direção textual food-tech premium. Não constituem alegação de fidelidade a uma referência que não foi disponibilizada.

## Capturas para nova revisão

Geradas do build estático pelo teste Playwright versionado, com sabores iniciais e sem dados pessoais:

| Visão            | Página completa                    | Hero                                         | Planos                                            |
| ---------------- | ---------------------------------- | -------------------------------------------- | ------------------------------------------------- |
| Desktop — 1440px | [Desktop](screenshots/desktop.png) | [Hero desktop](screenshots/desktop-hero.png) | [Planos desktop](screenshots/desktop-pricing.png) |
| Mobile — 375px   | [Mobile](screenshots/mobile.png)   | [Hero mobile](screenshots/mobile-hero.png)   | [Planos mobile](screenshots/mobile-pricing.png)   |

Nas capturas, o header permanece na posição normal do documento para não cobrir as seções durante a captura de elementos.

As capturas são material de revisão humana, não testes automáticos de comparação de pixels. Podem variar conforme sistema e versão do navegador.

## Reproduzir testes e capturas

Na raiz, com Node/pnpm compatíveis:

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm check
pnpm test
pnpm test:e2e
UPDATE_DESIGN_SCREENSHOTS=1 pnpm test:e2e
```

`pnpm test:e2e` gera o build e inicia/encerra o preview local na porta 4323. A configuração testa desktop/mobile sem depender de caminhos de instalação do computador do autor. Como alternativa para desenvolvimento com Chrome já instalado: `WHITEOVEN_BROWSER_CHANNEL=chrome pnpm test:e2e`.

O Chromium instalado pelo Playwright é a referência da CI; `pnpm exec playwright install --with-deps chromium` instala também suas dependências no Linux. Falhas geram screenshots e traces em `test-results/`, publicados como artefato da CI. A geração de capturas em `docs/design/screenshots/` é explícita e não ocorre em execuções normais da CI.
