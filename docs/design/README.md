# Referência visual e revisão da landing

> Registro histórico da M0.1-A. O formulário e o build foram evoluídos na [M0.1-B](../architecture/m0-1b-lead-capture.md); as capturas preservam a revisão visual anterior.

## Direção "Brasa" (2026-10-27)

O Product Owner aprovou uma revisão imersiva da landing, com GSAP (ScrollTrigger e SplitText) e Lenis como dependências. O creme e o laranja continuam; seções de impacto passam a usar um carvão quente (`#16110D`) e o laranja funciona como luz.

- **Efeitos:** pré-carregamento "aquecendo o forno" em visitas novas, hero com pizza que gira com o scroll e inclina com o cursor, ingredientes em parallax, marquee guiado pela velocidade do scroll, vitrine fixa de marcas fictícias (o mesmo app trocando de identidade), funcionalidades em scroll horizontal no desktop, painel que se monta, linha de etapas que se acende, cursor customizado, botões magnéticos e cards com brilho sob o cursor.
- **Implementação:** `src/scripts/motion.ts` concentra os efeitos em `gsap.matchMedia`; `src/styles/immersive.css` concentra o visual da direção. A página continua prerenderizada, utilizável sem JavaScript e sem requisições externas.
- **Acessibilidade:** com movimento reduzido nada se move nem fica fixo; cursor customizado e efeitos de ponteiro só existem com ponteiro preciso. Nenhum dado é guardado no navegador para o pré-carregamento.
- **Marcas da vitrine:** Forno da Vila, Nonna Pizzeria e Brasa Norte são fictícias e identificadas como prévia ilustrativa.

As capturas abaixo foram regeneradas com movimento reduzido, que mostra o layout estático.

## Referências recebidas em 2026-10-23

O Product Owner forneceu a imagem `whiteoven.jpeg` e um vídeo MP4 de 20,78 segundos nesta conversa. A imagem está preservada, convertida sem recorte para [whiteoven-visual-reference.png](whiteoven-visual-reference.png). O vídeo foi analisado por quadros em 1,04s, 5,20s, 10,39s, 15,59s e 19,74s. Um [quadro de referência](whiteoven-video-reference.jpg) foi registrado; o vídeo original permanece no anexo do Product Owner, sem integrar o bundle da landing.

O Product Owner autorizou explicitamente a publicação da imagem de referência e do quadro do vídeo na PR #2 do repositório `PetersonFonsec/White-Oven`. A dependência do asset foi atendida e os dois arquivos estão versionados para orientar a revisão. A aprovação visual das novas capturas cabe ao Product Owner; não afirmamos equivalência literal nem copiamos marca, textos ou layout completo. Os arquivos de referência em `docs/design` são material de análise, não assets usados no site. O envio dessas referências não foi tratado como licença para recortar e publicar suas fotografias.

## Aplicação da direção visual

- **Da imagem:** contraste entre creme/branco e painel laranja, pizza grande com aparência fotográfica, cards arredondados, sombras suaves e composição de aplicativo + gestão. O WhiteOven mantém nome, textos, logotipo e organização próprios.
- **Do vídeo:** resposta visual dos ingredientes à escolha do visitante. O Builder mantém sua estrutura SVG leve e agora combina uma base fotográfica própria com camadas de ingredientes e transição curta; a opção por movimento reduzido desativa a transição.
- **Fotos originais para o projeto:** hero e prévia mobile usam uma pizza gerada para o WhiteOven. A base sem toppings do Builder foi gerada separadamente. Nenhuma fotografia foi extraída das referências ou carregada de serviço externo. Proveniência em [assets.md](assets.md).
- **Escopo preservado:** demonstração de sabores inteiros/meio a meio e preço fictício pelo maior valor. Tamanhos, inclusão individual de ingredientes, carrinho e checkout vistos no vídeo não foram implementados.
- **Composição responsiva:** a miniatura de gestão complementa a visão desktop; o mobile prioriza a pizza e a prévia de aplicativo, mantendo o painel completo em sua seção própria.
- **Planos e formulário:** os ajustes anteriores permanecem: Flex destaca 3% por venda paga, Pro explicita 0% de comissão WhiteOven e o protótipo não envia dados.

## Capturas para nova revisão

Geradas do build estático pelo teste Playwright versionado, com sabores iniciais e sem dados pessoais:

| Visão            | Página completa                    | Hero                                         | Builder                                            | Planos                                            |
| ---------------- | ---------------------------------- | -------------------------------------------- | -------------------------------------------------- | ------------------------------------------------- |
| Desktop — 1440px | [Desktop](screenshots/desktop.png) | [Hero desktop](screenshots/desktop-hero.png) | [Builder desktop](screenshots/desktop-builder.png) | [Planos desktop](screenshots/desktop-pricing.png) |
| Mobile — 375px   | [Mobile](screenshots/mobile.png)   | [Hero mobile](screenshots/mobile-hero.png)   | [Builder mobile](screenshots/mobile-builder.png)   | [Planos mobile](screenshots/mobile-pricing.png)   |

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
