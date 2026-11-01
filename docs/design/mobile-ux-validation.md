# App mobile · Relatório final da refatoração de UX/UI

Data: 2026-11-01. Série de PRs empilhadas: #51 → #52 → #53 → #54 → #55 → esta (#56).
Diagnóstico e plano em [`mobile-ux-audit.md`](./mobile-ux-audit.md). Validação feita com testes
automatizados, checagens estáticas e uma prévia web local com API sintética. **Não houve
simulador iOS nem iPhone** (ver §7), então o roteiro da §8 é a validação que falta.

## 1. Inventário de telas

| Tela                               | Antes                                      | Depois                                                                                                       | PR       |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------- |
| Loja indisponível                  | Botões sob a barra de status (P0-1)        | `StoreScreen` com `Screen` e ações em lista                                                                  | #51      |
| Cardápio (home, busca, categorias) | Destaque com altura fixa, busca sem limpar | Cabeçalho com status da loja, destaque flexível, busca com limpar, categorias em `tablist`, cartões tocáveis | #53      |
| Pizza Builder                      | Duas listas de sabores, botão some         | Etapas numeradas, seletor de metade, uma lista, rodapé fixo com o que falta, confirmação ao sair             | #54      |
| Builder: sabor indisponível        | Voltar sob a barra de status (P0-2)        | `ScreenHeader` com "‹ Cardápio"                                                                              | #51      |
| Sacola e checkout                  | Tudo numa rolagem, total abaixo da dobra   | Stepper, Entrega/Retirada, rodapé fixo com uma ação e o motivo do bloqueio                                   | #55      |
| Pedido recebido                    | Cartão no topo da sacola                   | Tela própria com "Acompanhar pedido"                                                                         | #55      |
| Sacola vazia                       | Sem saída                                  | Estado vazio com "Ver o cardápio"                                                                            | #55      |
| Recuperação de pedido pendente     | Texto e botões soltos                      | Mesma regra (ADR 0022), rodapé fixo com a ação                                                               | #55      |
| Entrar / Criar conta               | Chips, termos expandidos no formulário     | Controle segmentado, marca da loja, validação por campo, termos em folha, retorno à origem                   | #52      |
| Minha conta                        | Muro de botões                             | Seções: endereços, avisos, termos, sair e excluir                                                            | #52      |
| Endereço novo/editar               | Formulário no fim da conta                 | Tela própria; aberta pela sacola, volta para a sacola                                                        | #52, #55 |
| Excluir conta                      | Inline                                     | Tela própria                                                                                                 | #52      |
| Pedidos                            | Cartão não tocável, status em texto        | Aba com cartões tocáveis, `StatusBadge`, puxar para atualizar, estados vazio e "entre na conta"              | #55      |
| Acompanhamento                     | Texto corrido                              | Etapas com "AGORA", previsão, ligar para a pizzaria, itens, resumo e histórico; anuncia mudanças             | #55      |

Telas que não existem porque a API não tem o recurso (onboarding, recuperação de senha,
verificação de e-mail, edição de dados pessoais, detalhes de produto simples, relato de problema
na entrega): ver §9.

## 2. Problemas por gravidade e situação

| Id    | Problema                                         | Situação                      | PR       |
| ----- | ------------------------------------------------ | ----------------------------- | -------- |
| P0-1  | Loja indisponível: ações sob a barra de status   | Corrigido                     | #51      |
| P0-2  | Builder, sabor indisponível: voltar inalcançável | Corrigido                     | #51      |
| P1-1  | Safe Area em elementos fixos                     | Corrigido                     | #51      |
| P1-2  | Voltar inconsistente                             | Corrigido (`ScreenHeader`)    | #53      |
| P1-3  | Retorno à origem (conta e endereço)              | Corrigido                     | #52, #55 |
| P1-4  | Erros não anunciados no VoiceOver                | Corrigido (`announce`)        | #51      |
| P1-5  | Contraste do texto de erro                       | Corrigido (`errorText`)       | #51      |
| P1-6  | CTA desabilitado sem motivo                      | Corrigido (cadastro e sacola) | #52, #55 |
| P1-7  | Checkout em duas etapas abaixo da dobra          | Corrigido (rodapé fixo)       | #55      |
| P1-8  | Itens da sacola com três botões de texto         | Corrigido (`QuantityStepper`) | #55      |
| P1-9  | Builder: botão some com a pizza incompleta       | Corrigido                     | #54      |
| P1-10 | Builder: meio a meio difícil de acompanhar       | Corrigido                     | #54      |
| P1-11 | Destaque do cardápio com altura fixa             | Corrigido                     | #53      |
| P1-12 | Adicionar produto sem retorno                    | Corrigido (toast)             | #53      |
| P1-13 | Formulários: foco, envio pelo teclado, AutoFill  | Corrigido                     | #52      |
| P2-1  | Sacola ou carrinho                               | Corrigido ("Sacola")          | #53      |
| P2-2  | Ícones das abas em Unicode                       | Corrigido (Ionicons)          | #51      |
| P2-3  | Ações duplicadas                                 | Corrigido                     | #53, #55 |
| P2-4  | Marca da WhiteOven numa loja white label         | Corrigido                     | #52      |
| P2-5  | Minha conta é um muro de botões                  | Corrigido                     | #52      |
| P2-6  | Termos dentro do cadastro                        | Corrigido (`LegalSheet`)      | #52      |
| P2-7  | Pedidos                                          | Corrigido                     | #55      |
| P2-8  | Pedido recebido misturado à sacola               | Corrigido                     | #55      |
| P2-9  | Sacola vazia sem caminho                         | Corrigido                     | #55      |
| P2-10 | Cartão de pizza pouco tocável                    | Corrigido                     | #53      |
| P2-11 | Rótulos sobre a foto no builder                  | Corrigido                     | #54      |
| P2-12 | Sair do builder perde a pizza                    | Corrigido                     | #54      |
| P2-13 | Busca                                            | Corrigido                     | #53      |
| P2-14 | Placeholder com 2,8:1                            | Corrigido                     | #51      |
| P2-15 | Estilos isolados                                 | Corrigido nas telas refeitas  | #51–#55  |
| P3-1  | "1 itens"                                        | Corrigido (`plural`)          | #53      |
| P3-2  | Cartões só com borda                             | Corrigido (`theme.shadow`)    | #51      |
| P3-3  | "Processando…" solto                             | Corrigido (loading no botão)  | #51–#55  |
| P3-4  | Categorias com papel `button`                    | Corrigido (`tablist`/`tab`)   | #53      |
| P3-5  | Emoji 🍕 lido pelo VoiceOver                     | Corrigido (ícone decorativo)  | #53      |

Todos os 35 problemas do diagnóstico foram tratados. A confirmação final de P1-1, P1-4 e P1-13
depende do aparelho (§7).

## 3. Melhorias por área

- **Acessibilidade:**
  - alvos de 44 pt ou mais (`IconButton`, `QuantityStepper`, `ListRow` com 56 pt);
  - papéis e estados em abas, rádios, caixas de seleção e controles segmentados;
  - erros, toasts, total cotado e mudança de status anunciados com `announceForAccessibility`, porque o iOS ignora live regions;
  - estado nunca só pela cor: ✓, "EDITANDO", "AGORA", ícone no badge.
- **Contraste:** todos os pares de texto fixos passam de 4,5:1, e há teste para isso. Texto sobre laranja usa `onPrimary` escuro (6,34:1).
- **Dynamic Type:** nenhuma altura fixa em texto; os cartões crescem com a fonte. Sem `numberOfLines` em conteúdo essencial.
- **Safe Area e teclado:**
  - insets reais em abas, rodapés fixos, folhas e toasts;
  - `KeyboardAvoidingView` nas telas com campos;
  - "OK" acima dos teclados numéricos;
  - o rodapé fixo sobe com o teclado.
- **Hierarquia visual:** cabeçalhos grandes nas abas e cabeçalho com voltar nas telas empilhadas; seções em cartões com sombra suave; espaçamento só por `theme.spacing`.
- **Estados:** carregando, erro com "Tentar novamente", vazio, offline e cardápio desatualizado em todas as telas. Nenhum sucesso é mostrado antes de a API confirmar.

## 4. Componentes criados ou alterados

| Componente                                                                                                | Arquivo                                      | Situação   |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------- |
| `Screen`, `ScreenHeader`, `StickyFooter`, `TabBarContext`                                                 | `components/Screen.tsx`                      | novo       |
| `Icon`, `IconButton`                                                                                      | `components/Icon.tsx`                        | novo       |
| `InlineMessage`, `ToastProvider`, `useToast`                                                              | `components/Feedback.tsx`                    | novo       |
| `QuantityStepper`                                                                                         | `components/QuantityStepper.tsx`             | novo       |
| `Section`, `ListRow`                                                                                      | `components/ListRow.tsx`                     | novo       |
| `SegmentedControl`                                                                                        | `components/SegmentedControl.tsx`            | novo       |
| `LegalSheet`                                                                                              | `components/LegalSheet.tsx`                  | novo       |
| `TotalRow`, `StatusBadge`                                                                                 | `components/TotalRow.tsx`, `StatusBadge.tsx` | novo       |
| `useAnnouncement`, `announce`                                                                             | `a11y/useAnnouncement.ts`                    | novo       |
| Regras de layout                                                                                          | `components/layout.ts`                       | novo, puro |
| `Button` (ícone, loading), `Field` (ref, erro, senha, `doneBar`), `Body alert`, `SurfaceCard`, `FormPage` | `components/Form.tsx`                        | alterado   |
| `BottomNavigation`                                                                                        | `components/BottomNavigation.tsx`            | refeito    |
| `PizzaVisual` (`activeSide`, rótulos em pílula)                                                           | `components/PizzaVisual.tsx`                 | alterado   |
| Tokens `errorText`, `successSurface`; `placeholder` e `shadow` no tema                                    | `design-tokens`, `brand/`                    | novo       |

A lógica de tela nova fica em módulos puros, testados com `node --test`:

- `customer/auth-form.ts`
- `menu/search.ts`
- `builder/flow.ts`
- `cart/checkout-flow.ts`
- `customer/order-progress.ts`

## 5. Mudanças de navegação

- A máquina de estados (`screenFor`) foi mantida, com as regras de loja indisponível e recuperação de pedido pendente.
- **Abas:** sem botão de voltar. Badge com o número de unidades e `tablist` com "aba 2 de 4".
- **Telas empilhadas:** `ScreenHeader` com "‹ Origem", lido como "Voltar para Origem".
- **`returnTo` na conta:**
  - entrar pela sacola ou pelos pedidos volta para lá depois do login;
  - `startWith: "address"` abre o formulário de endereço pela sacola e volta para a sacola ao salvar.
- **Android:** o botão voltar sobe um nível por vez (`destinationOnBack`).
- **Pedido aberto da sacola:** volta para a sacola. Aberto da lista, volta para Pedidos.
- **Pendente (decisão do PO):** o gesto de voltar nativo do iOS exige uma pilha nativa. Ver §9.

## 6. Testes e resultados

- **Testes do mobile (`pnpm --filter @whiteoven/mobile test`):** 185/185 passando. Os novos ou ampliados nesta série:

  | Arquivo                 | O que cobre                                                                    |
  | ----------------------- | ------------------------------------------------------------------------------ |
  | `layout.test.ts`        | Insets, espaçamento inferior, rótulo das abas, badge, plural                   |
  | `colors.test.ts`        | 4,5:1 para cada par de texto fixo                                              |
  | `auth-form.test.ts`     | Validação de entrar e cadastrar, primeiro erro e resumo                        |
  | `navigation.test.ts`    | Retorno à origem, rótulos de voltar, voltar sem loop, endereço pela sacola     |
  | `menu-search.test.ts`   | Busca sem acento, filtro por categoria, unidades da sacola                     |
  | `builder-flow.test.ts`  | Metade editada, troca automática, rodapé com motivo e total do `pizza-pricing` |
  | `checkout-flow.test.ts` | Ordem dos bloqueios do checkout, etapas de entrega e retirada                  |

  Os testes que já existiam continuam passando sem alteração: carrinho persistido, `CommerceModel`, cliente HTTP, recuperação pendente, reorder, builder e preços.

- **Checagens:** `pnpm typecheck`, `pnpm lint` e `pnpm format:check` passam no monorepo. Os testes de `brand-rules` da API passam com os tokens novos.
- **Build:** `expo export --platform ios` gerou o bundle nas fases 2 a 5.
- **Prévia web (iPhone 13, 390×844):** Playwright percorreu os fluxos A a E com uma API sintética. As capturas estão em `mobile-ux/previa/`. A prévia não simula Safe Area real, teclado nem VoiceOver.

## 7. Limitações da validação

- Não houve simulador iOS nem iPhone, porque o ambiente é Linux. Safe Area, teclado, VoiceOver e Dynamic Type no tamanho máximo foram verificados pelo código e pelas APIs, não no aparelho.
- A prévia web roda `react-native-web`. Sombras, fontes, `Alert` e `KeyboardAvoidingView` se comportam diferente no iOS.
- Não houve teste de interface automatizado no nativo; o projeto não tem Detox nem Maestro. A cobertura de tela vem dos módulos puros e do roteiro manual.
- As duas dependências novas (`react-native-safe-area-context` e `@expo/vector-icons`) já vêm no Expo Go do SDK 58, mas **builds EAS de preview precisam ser gerados de novo**.

## 8. Checklist manual no iPhone

Testar num iPhone com Dynamic Island (14 Pro ou mais novo) e, se possível, num com notch (iPhone 11 a 13) e num SE.

**Safe Area e layout**

- [ ] Nenhum texto ou botão sob a Dynamic Island, o notch ou o indicador de início, em todas as telas.
- [ ] Abas, rodapés fixos (builder, sacola, cadastro) e toasts ficam acima do indicador de início.
- [ ] A folha dos termos (pageSheet) respeita as margens no topo e embaixo.

**Teclado**

- [ ] Entrar e Criar conta: "Seguinte" passa de campo em campo, e "Entrar" ou "Criar conta" envia.
- [ ] O campo ativo e o botão principal nunca ficam escondidos pelo teclado.
- [ ] Troco e CEP mostram "OK" acima do teclado numérico.
- [ ] O AutoFill sugere e-mail, senha forte no cadastro e endereço.
- [ ] O olho mostra e esconde a senha.

**VoiceOver**

- [ ] As abas são lidas como "Sacola, 1 item, aba 2 de 4".
- [ ] Errar a senha faz o erro ser anunciado.
- [ ] Enviar o cadastro vazio anuncia "Há N campos para corrigir", e o foco vai para o primeiro campo com erro.
- [ ] Adicionar um produto anuncia "X na sacola".
- [ ] Builder: "Editar metade direita, botão de opção, selecionado". O rodapé bloqueado diz o que falta.
- [ ] Sacola: o stepper é lido como "Diminuir/Aumentar quantidade de X", e o total cotado é anunciado.
- [ ] Acompanhamento: as etapas são lidas como "Etapa 1 de 5: Aguardando confirmação", e uma mudança de status é anunciada.

**Dynamic Type** (Ajustes → Acessibilidade → Tela e Tamanho do Texto → Texto Maior, no máximo)

- [ ] Cardápio, builder, sacola e pedidos não cortam texto, e os botões crescem.
- [ ] O rodapé fixo do builder e da sacola continua utilizável.

**Contraste e cor**

- [ ] Com "Aumentar contraste" e em luz forte, os textos de erro, as dicas e os placeholders continuam legíveis.
- [ ] Com Ajustes → Acessibilidade → Filtros de cor (escala de cinza), a metade editada, a etapa atual e o status do pedido continuam claros.

**Fluxos**

- [ ] **A · Novo cliente:** Perfil → Criar conta → aceitar os termos pela folha → conta criada.
- [ ] **B · Cliente existente:** Sacola com itens → "Entrar para pedir" → entrar → volta para a sacola com o formulário intacto.
- [ ] **C · Compra com entrega e sem endereço:** "Adicionar endereço" → salvar → volta para a sacola → Revisar total → Confirmar → tela "Pedido #N recebido".
- [ ] **D · Meio a meio:**
  - o app passa sozinho para a metade direita;
  - o total bate com o maior preço mais a taxa;
  - sair sem adicionar pede confirmação.
- [ ] **E · Acompanhamento:** mudar o status no painel da loja; em até 20 s a tela atualiza e anuncia.
- [ ] **Loja fechada pelo painel:** o cardápio mostra o aviso, e a recuperação de pedido pendente continua acessível.

## 9. Pendências para a próxima PR

1. **Gesto de voltar do iOS:** migrar as telas empilhadas para uma pilha nativa (`react-native-screens` e `@react-navigation/native-stack`), mantendo `screenFor`. A decisão do PO está pendente.
2. **Testes de interface no nativo:** Maestro ou Detox para os fluxos A a E, rodando no CI com um simulador iOS.
3. **Telas que dependem de backend:**
   - recuperação de senha;
   - verificação de e-mail;
   - edição de nome e telefone (`PUT me`);
   - detalhes de produto simples;
   - relato de problema na entrega.
4. **Formatar o telefone da loja** no acompanhamento (hoje aparece como a API envia, por exemplo `+5511999999999`).
5. **Validar no aparelho** com o checklist da §8 e corrigir o que aparecer. Um caminho é uma sessão Remote Control no Mac do PO, com o simulador, para capturas em vários tamanhos.
6. **Gerar de novo os builds EAS de preview,** por causa das dependências nativas novas.
