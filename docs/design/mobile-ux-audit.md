# App mobile · Auditoria de UX/UI e plano de refatoração

Data: 2026-11-01. Base: `main` em `13f8d53` (depois da PR #50, "refresh app design system").
Escopo: `apps/mobile` (Expo SDK 58, React Native 0.88), todas as telas existentes. Esta auditoria
foi feita lendo o código e medindo contrastes; não houve simulador nem iPhone nesta etapa (ver
"Limitações").

## 1. Como o app está montado

- **Navegação:** não há biblioteca de navegação. `App.tsx` guarda `destination` (conta, sacola,
  pedidos, pedido) e `building` (sabor aberto no builder); `screenFor` em
  `src/navigation/app-state.ts` decide a tela e carrega regras de negócio testadas (loja
  indisponível bloqueia sacola e builder, sacola só abre para recuperar confirmação pendente).
  Não existe pilha: não há gesto de voltar do iOS, e "voltar" é sempre um botão. O Android usa
  `BackHandler`, que volta direto ao cardápio.
- **Abas inferiores:** `BottomNavigation` com Cardápio, Sacola, Pedidos e Perfil. Aparece no
  cardápio, sacola, pedidos e conta; some no builder e na loja indisponível.
- **Design System:** tokens em `packages/design-tokens/tokens.json`, adaptados em
  `src/brand/theme.tsx` (cores da loja + cores fixas, espaçamento, raios, tipografia). Componentes
  compartilhados: `Body`, `Heading`, `Button`, `Field`, `SurfaceCard`, `Divider`, `FormPage`
  (`src/components/Form.tsx`), `Choice`, `PizzaVisual` e `BottomNavigation`. O Builder ainda usa
  um `StyleSheet` próprio com tamanhos fixos, e cardápio, pedidos e builder repetem estilos inline.
- **Safe Area:** não há `SafeAreaProvider` nem leitura de insets. As telas dependem de
  `contentInsetAdjustmentBehavior="automatic"` no `ScrollView`, que só protege o conteúdo
  rolável. Elementos fixos usam números: a barra de abas usa `paddingBottom: 24` no iOS (o
  indicador de início ocupa 34 pt) e o rodapé do builder usa 12.
- **Teclado:** `FormPage` usa `KeyboardAvoidingView` (padding no iOS) com `ScrollView`. O
  cardápio (busca) não tem tratamento de teclado.
- **Tipografia:** fonte do sistema, `allowFontScaling` padrão (o texto acompanha o tamanho do
  sistema). Os problemas vêm de alturas fixas e de `numberOfLines`.

## 2. Inventário de telas

| #   | Tela                                          | Onde                                       | Observação                                                                                 |
| --- | --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------ |
| 1   | Abertura (carregando a loja)                  | `App.tsx`                                  | Spinner com o nome da loja.                                                                |
| 2   | App sem configuração                          | `App.tsx`                                  | Erro de build; só para desenvolvimento.                                                    |
| 3   | Loja indisponível / fechada sem cardápio      | `StoreScreen` + botões em `App.tsx`        | Conta, pedidos e recuperar pedido pendente.                                                |
| 4   | Cardápio (home, busca e categorias juntos)    | `MenuScreen`                               | Destaque, busca local, filtros, lista.                                                     |
| 5   | Pizza Builder                                 | `BuilderScreen` + `PizzaVisual` + `Choice` | Tamanho, meio a meio, sabores, borda, adicionais, retirar ingredientes, quantidade, preço. |
| 5a  | Builder: troca de tamanho bloqueada/confirmar | `BuilderScreen`                            | Cartão de alerta em linha.                                                                 |
| 5b  | Builder: sabor indisponível                   | `BuilderScreen`                            | Texto e botão voltar.                                                                      |
| 6   | Sacola + checkout + orçamento + confirmação   | `CheckoutScreen`                           | Tudo numa rolagem.                                                                         |
| 6a  | Pedido recebido (recibo)                      | `CheckoutScreen`                           | Cartão no topo da mesma tela.                                                              |
| 6b  | Confirmação pendente / recuperação            | `CheckoutScreen`                           | Também no modo "loja indisponível".                                                        |
| 7   | Entrar / Criar conta                          | `AccountScreen`                            | Mesmo formulário, alternado por chips; termos inline.                                      |
| 8   | Minha conta                                   | `AccountScreen`                            | Termos, avisos (push), endereços, excluir conta.                                           |
| 8a  | Endereço: novo/editar                         | `AccountScreen`                            | Formulário inline no fim da conta.                                                         |
| 9   | Meus pedidos                                  | `OrdersScreen`                             | Lista paginada; estado "entre na conta".                                                   |
| 10  | Detalhe e acompanhamento                      | `OrdersScreen`                             | Status, linha do tempo, itens, cancelar, pedir novamente.                                  |
| 11  | Diálogos nativos                              | `Alert.alert`                              | Remover endereço, excluir conta, cancelar pedido, pedir novamente, liberar pendente.       |

**Telas da lista de referência que não existem no app**, porque a API não tem o recurso:
boas-vindas/onboarding, recuperação de senha, verificação de e-mail, edição de dados pessoais
(não há `PUT me`), detalhes de produto simples (só pizza tem tela própria) e relato de problema
na entrega (incidentes são só da equipe, ADR 0019). Não serão criadas nesta série: ou precisam
de backend, ou não têm função sem ele. Estão em "Pendências".

## 3. Fluxos

- **A · Novo cliente:** não há boas-vindas; o app abre no cardápio. Cadastro em Perfil →
  "Criar conta" (nome, celular, e-mail, senha, termos). Não há verificação de e-mail. Depois do
  cadastro a tela vira "Minha conta"; nada leva de volta ao que a pessoa fazia.
- **B · Cliente existente:** Perfil → Entrar → "Minha conta". Para pedir, a pessoa precisa
  achar a aba Cardápio sozinha.
- **C · Compra:** Cardápio → "Montar pizza" → Builder → "Adicionar ao carrinho" → Sacola →
  (sem conta: "Entrar ou criar conta" leva à conta, e "Voltar" volta ao **cardápio**, não à
  sacola) → Entrega exige endereço, que só se cadastra em Minha conta (a sacola desmonta e perde
  entrega, pagamento, troco e observações) → "Calcular total na loja" → o orçamento aparece
  abaixo da dobra → "Confirmar pedido" → recibo no topo da sacola.
- **D · Meio a meio:** Builder → "Meio a meio" → duas listas completas de sabores empilhadas
  ("Sabor da metade esquerda", "Sabor da metade direita") → borda → adicionais por metade →
  retirar ingredientes por metade → quantidade → preço. Enquanto falta a segunda metade, o botão
  de adicionar some.
- **E · Acompanhamento:** Pedidos → "Ver pedido" → detalhe com atualização a cada 20 s.

## 4. Problemas encontrados

Formato: **tela** · comportamento atual → esperado · correção proposta (fase).

### P0 · Bloqueantes

- **P0-1 · Loja indisponível.** "Minha conta", "Meus pedidos" e "Recuperar pedido pendente" são
  renderizados num `View` sem Safe Area, no topo da janela: no iPhone com Dynamic Island ou notch
  ficam atrás da barra de status. O de recuperação é o único caminho para resolver um pedido
  pendente com a loja suspensa. → Ações visíveis e tocáveis. · Levar as ações para dentro do
  `StoreScreen`, numa tela com Safe Area (fase 2).
- **P0-2 · Builder, sabor indisponível.** O botão "Voltar" fica num `View` com 16 pt de padding,
  atrás da barra de status. Não há aba inferior no builder nem gesto de voltar: a pessoa fica presa.
  → Sempre há um voltar visível. · Cabeçalho com Safe Area em todas as telas (fase 2).

### P1 · Alto

- **P1-1 · Safe Area em elementos fixos.** A barra de abas usa 24 pt fixos (o indicador de
  início tem 34 pt; num iPhone SE sobra espaço) e o rodapé do builder não respeita o indicador.
  → Insets reais do aparelho. · `react-native-safe-area-context` (já incluído no Expo Go e no
  SDK 58), `SafeAreaProvider` na raiz e componentes `Screen`/`StickyFooter` (fase 2).
- **P1-2 · Voltar inconsistente.** Cinco formas diferentes ("← Voltar ao cardápio", "‹ Voltar",
  botão secundário "Voltar ao cardápio" de largura total, "Voltar", "Voltar aos pedidos"). Telas
  de aba (sacola, pedidos, conta) têm voltar, que sempre leva ao cardápio. → Abas não têm voltar;
  telas empilhadas (builder, detalhe do pedido, endereço) têm um cabeçalho padrão com voltar
  rotulado. · `ScreenHeader` compartilhado (fases 2 e 4).
- **P1-3 · Retorno à origem.** Entrar pela sacola ou por pedidos e depois tocar em Voltar leva ao
  cardápio; depois de entrar, nada volta à sacola. Cadastrar endereço a partir da sacola desmonta
  o checkout e perde entrega, pagamento, troco e observações. → Depois de entrar, volta para onde
  estava; endereço cadastrado sem perder o checkout. · `returnTo` na navegação de conta; estado
  do checkout preservado e endereço em tela própria com retorno (fases 3 e 6).
- **P1-4 · Erros não anunciados no VoiceOver.** `accessibilityLiveRegion` só funciona no Android
  e o papel `alert` não é anunciado sozinho no iOS. Erros de login, de cadastro, ao adicionar e no
  checkout passam em silêncio. → Anúncio quando o erro aparece. · `useAnnouncement` com
  `AccessibilityInfo.announceForAccessibility` dentro de `Body alert`/`InlineMessage` (fase 2).
- **P1-5 · Contraste do texto de erro.** `#D93B3B` tem 4,37:1 no creme e 4,12:1 em
  `errorSurface` (mínimo 4,5:1). → ≥ 4,5:1. · Novo token `errorText` `#B42318` (6,57:1 no branco,
  5,98:1 em `errorSurface`) para texto; `error` continua em bordas (fase 2).
- **P1-6 · CTA desabilitado sem motivo.** "Criar conta" fica desabilitado até nome, senha de 10+
  caracteres e aceite, sem dizer o que falta. No checkout, "Calcular total" fica desabilitado sem
  conta, sem endereço, com a loja fechada ou o cardápio desatualizado; os motivos aparecem
  espalhados ou não aparecem. → O motivo fica junto do botão e é lido pelo VoiceOver. · Validação
  ao enviar, com erro no campo, e `disabledReason` no rodapé de ação (fases 3 e 6).
- **P1-7 · Checkout em duas etapas abaixo da dobra.** Depois de "Calcular total na loja", o total
  e "Confirmar pedido" aparecem no fim da rolagem sem rolar nem anunciar; parece que nada
  aconteceu. → O total e a ação principal ficam sempre visíveis. · Rodapé fixo com total e
  ação (calcular, depois confirmar) e anúncio do total (fase 6).
- **P1-8 · Itens da sacola.** Cada item tem três botões de texto ("Diminuir Margherita",
  "Aumentar Margherita", "Remover Margherita") que quebram em várias linhas. Remover não pede
  confirmação nem permite desfazer. → Stepper − 1 + compacto e remover com ícone e rótulo
  acessível. · `QuantityStepper` compartilhado (fases 2 e 6).
- **P1-9 · Builder: o botão some com a pizza incompleta.** No meio a meio, sem o segundo sabor,
  o rodapé desaparece e o motivo fica no fim da rolagem. → Rodapé sempre presente, desabilitado,
  com o que falta ("Escolha o sabor da metade direita"). (fase 5)
- **P1-10 · Builder: meio a meio difícil de acompanhar.** A pizza de 240 pt sai da tela ao
  rolar; as duas listas completas de sabores ficam empilhadas; adicionais e retiradas também se
  repetem por metade. Não dá para saber de relance qual metade se configura. → Uma lista de sabores,
  com seletor "Metade 1 / Metade 2" fixo junto da prévia; a metade ativa marcada por texto, ícone e
  contorno, não só por cor. · Prévia compacta fixa e seletor de metade (fase 5).
- **P1-11 · Destaque do cardápio com altura fixa.** O cartão tem 200 pt e `overflow: hidden`:
  com texto grande, nome e preço são cortados. → Altura mínima e conteúdo que cresce. (fase 4)
- **P1-12 · Adicionar produto sem retorno.** "Adicionar" num produto simples não mostra nem
  anuncia nada; só o número da aba muda. → Confirmação visível e anunciada. · `Toast` acessível
  com "Ver sacola" (fases 2 e 4).
- **P1-13 · Formulários.** `returnKeyType="next"` sem mover o foco; "Entrar" não envia pelo
  teclado; celular e endereço sem `textContentType`/`autoComplete`; o teclado decimal do troco não
  tem como fechar. → Navegação campo a campo, envio pelo teclado e preenchimento automático do iOS.
  · `Field` com `ref`, `onSubmitEditing` e tipos de conteúdo (fases 2, 3 e 6).

### P2 · Médio

- **P2-1 · Sacola ou carrinho.** A aba diz "Sacola"; o builder, "Adicionar ao carrinho"; o
  checkout, "Carrinho e checkout"; o cardápio, "Carrinho (0)". → Um nome só: **Sacola**.
- **P2-2 · Ícones das abas.** Caracteres Unicode (⌂ para Cardápio, ＋ para Sacola, ○ para Perfil)
  que não comunicam a função. Rótulo de 11 pt e `numberOfLines={1}`. A quantidade da sacola só
  aparece dentro do texto. Sem papel `tablist`. → Ícones claros, selo com a quantidade, rótulo
  de 12 pt e anúncio "Sacola, 2 itens, aba 2 de 4". · `Icon` (`@expo/vector-icons`, incluído no
  SDK) e nova `BottomNavigation`.
- **P2-3 · Ações duplicadas.** O botão "Carrinho (0)" no topo do cardápio repete a aba. "Minha
  conta" e "Meus pedidos" se repetem na sacola, na lista e no detalhe do pedido.
- **P2-4 · Marca da WhiteOven numa loja white label.** A tela de entrar mostra um "W". → Logo ou
  inicial da loja.
- **P2-5 · Minha conta é um muro de botões.** Sair, termos, avisos, cada endereço com dois botões
  de largura total, excluir conta no mesmo peso visual. → Seções em lista, com linhas tocáveis e
  a zona de exclusão separada.
- **P2-6 · Termos dentro do cadastro.** Os dois documentos se expandem dentro do formulário e
  empurram o botão para longe. → Abrir em folha (`Modal` pageSheet) com fechar claro.
- **P2-7 · Pedidos.** Cartão não tocável (só o botão "Ver pedido"), status como texto simples,
  "Atualizar lista" em vez de puxar para atualizar. No detalhe: texto técnico ("Atualização
  automática a cada 20 segundos"), "Cancelar pedido" sem estilo destrutivo, resumo sem
  alinhamento de valores, linha do tempo sem marcação visual. → Cartão tocável, selo de status
  com texto, progresso das etapas, resumo em tabela.
- **P2-8 · Pedido recebido.** O recibo é um cartão no topo da sacola, misturado ao resto. → Estado
  de sucesso próprio, com número, total e "Acompanhar pedido".
- **P2-9 · Sacola vazia** sem caminho de volta ao cardápio. → Estado vazio com "Ver cardápio".
- **P2-10 · Cartão de pizza no cardápio.** Só o botão pequeno "Montar pizza" é tocável; o cartão
  todo deveria abrir o builder.
- **P2-11 · Rótulos sobre a foto no builder.** "Esquerda"/"Direita" são escritos direto sobre a
  foto, sem fundo: o contraste depende da imagem. → Rótulo em pílula com fundo.
- **P2-12 · Sair do builder perde a pizza** sem aviso. → Confirmar ao sair se algo foi mudado.
- **P2-13 · Busca.** Sem botão de limpar, sem tecla "Buscar", e o teclado cobre os resultados.
- **P2-14 · Placeholder com 2,8:1.** `textMuted` `#9E9690` no branco. → Usar `muted`
  (5,3:1) para placeholder.
- **P2-15 · Estilos isolados.** O builder, o cardápio e os pedidos repetem estilos que deveriam
  estar nos componentes compartilhados (cartões, títulos de seção, linhas de preço).

### P3 · Baixo

- **P3-1** "1 itens" (plural fixo) nas seções do cardápio.
- **P3-2** Cartões só com borda, sem sombra suave; muitas bordas competindo.
- **P3-3** "Processando…" solto no topo das telas em vez de loading no próprio botão.
- **P3-4** Categorias com papel `button`; o certo é `tab` dentro de `tablist`.
- **P3-5** Emoji 🍕 como imagem padrão é lido pelo VoiceOver em alguns lugares.

### Contraste medido (WCAG 2.2)

| Par                                             | Razão       | Situação                                                  |
| ----------------------------------------------- | ----------- | --------------------------------------------------------- |
| `onPrimary` `#1A1512` sobre `primary` `#FF6B00` | 6,34        | ok. O app não usa branco sobre laranja                    |
| Branco sobre `#FF6B00`                          | 2,86        | reprovado: não usar                                       |
| `accentText` `#9C4300` sobre branco/creme       | ≥ 5,8       | ok                                                        |
| `muted` `#6F6864` sobre creme                   | 5,28        | ok                                                        |
| `error` `#D93B3B` sobre creme / `errorSurface`  | 4,37 / 4,12 | reprovado para texto → `errorText`                        |
| `textMuted` `#9E9690` sobre branco              | 2,91        | reprovado para texto → só decorativo                      |
| `primary` como indicador (borda) sobre branco   | 2,86        | não basta sozinho: a seleção também usa preenchimento e ✓ |

## 5. Decisões de arquitetura

- **Navegação:** manter a máquina de estados (`screenFor`) e seus testes. Ela carrega regras de
  negócio (loja indisponível, recuperação de pedido pendente) que uma troca de biblioteca
  colocaria em risco. Melhorias: abas sem voltar, cabeçalho padrão nas telas empilhadas,
  `returnTo` para conta e endereço, Android voltando um nível por vez. O gesto de voltar nativo do
  iOS exige uma pilha nativa (`react-native-screens`); fica como decisão do PO para uma PR
  própria.
- **Dependências novas:** `react-native-safe-area-context` (o `SafeAreaView` do React Native está
  obsoleto e não cobre Android nem insets inferiores) e `@expo/vector-icons` (ícones). As duas
  constam em `expo/bundledNativeModules.json` do SDK 58 e já vêm no Expo Go. Builds EAS de
  preview precisam ser gerados de novo.

## 6. Plano de implementação

| Fase | PR   | Conteúdo                                                                                                                                                                                                                                                                                                                   |
| ---- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | esta | Diagnóstico (este documento).                                                                                                                                                                                                                                                                                              |
| 2    | 1    | Design System: Safe Area, `Screen`, `ScreenHeader`, `StickyFooter`, `Icon`, `IconButton`, `QuantityStepper`, `InlineMessage`, `Toast`, `useAnnouncement`, `Field` com foco encadeado e senha, `Button` com ícone e loading, nova `BottomNavigation`, token `errorText`. Corrige P0-1, P0-2, P1-1, P1-4, P1-5, P2-2, P2-14. |
| 3    | 2    | Autenticação: entrar/criar conta, termos em folha, validação por campo, retorno à origem, marca da loja, Minha conta em seções (endereço e exclusão em telas próprias). P1-3 (conta), P1-6 (cadastro), P1-13, P2-4, P2-5, P2-6.                                                                                            |
| 4    | 3    | Navegação principal e cardápio: cabeçalho, busca, categorias, cartões tocáveis, destaque flexível, retorno ao adicionar, abas sem voltar. P1-2, P1-11, P1-12, P2-1, P2-3, P2-10, P2-13.                                                                                                                                    |
| 5    | 4    | Pizza Builder: prévia fixa, seletor de metade, uma lista de sabores, rodapé sempre presente com o que falta, confirmação ao sair. P1-9, P1-10, P2-11, P2-12.                                                                                                                                                               |
| 6    | 5    | Sacola, checkout e pedidos: stepper, rodapé com total, recibo, endereço com retorno, lista e detalhe de pedidos. P1-3 (endereço), P1-6, P1-7, P1-8, P2-7, P2-8, P2-9.                                                                                                                                                      |
| 7    | 6    | Validação: testes, relatório e roteiro de testes no iPhone.                                                                                                                                                                                                                                                                |

Cada PR preserva `screenFor`, `createCommerceModel`, `evaluatePizza`/`changeSize` e as regras
dos ADRs 0020 a 0030. A lógica nova fica em módulos sem React Native, para que `node --test`
cubra.

## 7. Limitações desta auditoria

- Sem simulador iOS nem iPhone neste ambiente (Linux). Safe Area, teclado e VoiceOver foram
  avaliados pelo código e pelas APIs do React Native, não vistos no aparelho.
- A validação visual de cada fase depende do iPhone do PO ou de um simulador via Remote Control.
