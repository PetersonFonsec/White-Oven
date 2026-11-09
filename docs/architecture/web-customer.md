# Aplicativo web Angular do consumidor

O workspace `apps/web-customer` concentra a experiência web do cliente em uma única alteração para revisão. A SPA usa Angular 21.2.25, CLI/build 21.2.28, TypeScript 5.9, componentes standalone com OnPush, Signals, Reactive Forms, HttpClient, Angular Router, Vitest e Playwright. A landing Astro e o painel Angular têm públicos, sessões e ciclos de lançamento distintos.

## Diagnóstico e reaproveitamento

O painel fornece a referência de configuração do Angular. A sessão de staff usa cookie, MFA e troca de tenant. O cliente autentica pelo slug da loja, com access token em memória e refresh token no corpo. O backend aplica autorização, limites, RLS e as regras de pedido.

Os módulos puros anteriormente localizados no app Expo agora estão em `packages/customer-core`. Web e mobile usam os mesmos validadores de menu, projeções do catálogo, montagem por metade, sessão, carrinho, cotação, confirmação, leitura de pedidos e reconstrução de itens históricos. Os caminhos públicos do mobile reexportam as mesmas funções. Componentes nativos, SecureStore e push nativo continuam no app Expo. A API e ambos os clientes avaliam pizzas com `@whiteoven/pizza-pricing`. A validação de marca e de perfil público vive em `@whiteoven/contracts`.

## Navegação e dados

| Rota após `/lojas/:storeSlug`     | Comportamento                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| raiz e `cardapio`                 | Atendimento, destaques reais, categorias, busca por nome, descrição ou ingrediente e produtos com preço atual  |
| `montar/:flavorId`                | Tamanho, sabores, metades, borda, remoções, extras e quantidade, com avaliação e normalização compartilhadas   |
| `conta`, `cadastro`               | Login/cadastro, aceite das versões apresentadas pela API, perfil, endereços, preferência visual local e logout |
| `recuperar-acesso`, `verificacao` | Informação sobre a indisponibilidade desses serviços                                                           |
| `sacola`, `checkout`              | Revisão, quantidades, remoção, entrega/retirada, pagamento na entrega, cotação e confirmação                   |
| `pedidos`, `pedidos/:orderId`     | Histórico paginado com filtros, detalhe do snapshot, acompanhamento e reconstrução contra o cardápio atual     |

A navegação entre lojas recria o shell e seus serviços. Leituras públicas usam HttpClient sem credenciais. Cada área carrega sob demanda. O cliente reaproveita o transporte autenticado do mobile, que renova tokens, serializa a rotação e trata erros da API. Textos legais são exibidos apenas como blocos escapados. O tema da loja substitui os tokens permitidos após validação de contraste. A fonte Inter é hospedada localmente com sua licença. Fotos vêm da rota pública de imagens da pizzaria.

O menu fica em memória e uma falha ao atualizar indica que os valores podem ter mudado. A cotação exige loja aberta, catálogo atualizado, cliente autenticado, documentos aceitos e opções válidas. O valor devolvido pela API é apresentado antes da confirmação. Ao repetir um pedido, a interface recarrega o catálogo, informa quantos itens foram descartados e pede confirmação para substituir uma sacola existente.

## Sessão e recuperação

IndexedDB guarda registros cifrados com AES-GCM e uma chave não exportável por slug na origem. Cada gravação recebe um IV aleatório e autentica o nome do registro como dado adicional. O salvamento espera o commit da transação. O access token permanece em memória. A cifra protege os registros em repouso. Código malicioso executado na mesma origem ainda pode agir como o cliente, portanto a origem e os scripts servidos são parte da fronteira de confiança.

Um Web Lock por loja serializa o uso do modelo entre abas, inclusive durante a restauração e a última gravação em andamento. A confirmação persiste corpo, chave e identidade do cliente antes do POST. Uma resposta perdida mantém a sacola bloqueada até que a conta original consulte o mesmo pedido ou reconheça explicitamente o resultado após falar com a pizzaria. Uma chave expirada não é reenviada como novo pedido.

O histórico abre pedidos do cliente autenticado. O detalhe consulta mudanças a cada 20 segundos enquanto o documento está visível e o pedido está em andamento. Mudanças de rota ou identidade cancelam leituras anteriores.

## Limites da API e publicação

O backend oferece dinheiro, cartão na entrega e PIX na entrega, conforme a configuração de cada loja. Cobrança online, tokenização de cartões, QR Code/copia e cola de PIX, recuperação de senha, confirmação de e-mail e alteração de nome/e-mail/telefone dependem de novas APIs. O perfil permite as mutações de endereço existentes. A preferência de grade/lista vale apenas para o navegador e a loja.

A fundação usa renderização no navegador. SEO e SSR podem ser reavaliados com requisitos concretos de indexação pública. A paleta e a tipografia seguem a especificação textual; a comparação visual exata exige os mockups de referência. A PR prepara o aplicativo e seus testes para revisão. Provisionamento, publicação e aceite do piloto têm processos próprios.
