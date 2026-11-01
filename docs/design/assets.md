# Proveniência dos assets visuais

## Referências fornecidas pelo Product Owner

- `whiteoven-visual-reference.png`: conversão sem recorte da imagem `whiteoven.jpeg`, recebida em 2026-10-23. Contém marcas e produtos de terceiros; usada apenas para orientar a direção estética.
- `whiteoven-video-reference.jpg`: quadro de aproximadamente 19,74s do MP4 de referência de 20,78s recebido na mesma data. O vídeo demonstra montagem de pizza por camadas de ingredientes. Não é um vídeo produzido pelo WhiteOven.

Esses dois arquivos estão versionados em `docs/design`, com autorização explícita do Product Owner para publicação na PR #2 de `PetersonFonsec/White-Oven`, e não são importados pela aplicação. Não representam autorização para reutilizar fotos, marca, textos ou interface do material na landing.

## Assets gerados para a landing

- `apps/landing/src/assets/whiteoven-pizza.png`: criado com a ferramenta imagegen em 2026-10-23. Prompt de fotografia gastronômica original: pizza artesanal vista de cima, calabresa/cebola à esquerda e tomate/manjericão à direita, borda assada, fundo transparente, sem marcas ou texto. Não é foto de produto ou cliente real.
- `apps/landing/src/assets/whiteoven-pizza-base.png`: criado com imagegen na mesma data: base de pizza assada com molho e muçarela, vista de cima, sem toppings, com fundo transparente. Recebe ingredientes SVG independentes no Builder.

Os PNGs fonte permanecem no repositório. `astro:assets` e Sharp (declarado na landing, exigido pelo serviço de imagens do Astro) geram WebP durante o build estático; o hero tem variantes responsivas e dimensões reservadas. Não existe requisição para provedor de imagens no navegador. O logo e os grupos SVG de ingredientes continuam sendo código próprio do projeto.

## Kit de assets para o app

`apps/mobile/assets/whiteoven-kit/` contém sete PNGs gerados com imagegen em 2026-11-01 a partir das referências fornecidas pelo Product Owner: logo WhiteOven, confirmação de e-mail, pizza de abertura, forno 404, pedidos vazios, carrinho vazio e entregador a caminho. A publicação desses assets na PR foi autorizada pelo Product Owner nesta mesma tarefa.

O [README do kit](../../apps/mobile/assets/whiteoven-kit/README.md) registra os prompts e as orientações de uso; o [registro do entregador](../../apps/mobile/assets/whiteoven-kit/delivery-on-the-way.md) descreve a referência adicional. São arquivos para integração posterior, sem novas telas ou fluxos implementados. A logo é uma recriação raster, e a pizza não é fotografia de produto real. A identidade própria das lojas permanece independente desse kit.

## Capturas de revisão

`docs/design/screenshots/*` é gerado pelo Playwright a partir da landing local. São evidências para revisão humana; não devem ser confundidas com imagens da referência ou com baselines de comparação automática de pixels.
