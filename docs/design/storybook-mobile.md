# Storybook do app mobile

O app mobile (`apps/mobile`) tem um catálogo de componentes em Storybook para React Native. Ele roda **no próprio iPhone pelo Expo Go**, com as mesmas fontes, sombras, Safe Area e teclado do app, e também no navegador para uma conferência rápida.

## Como abrir

No iPhone (Expo Go do SDK 58):

```sh
cd apps/mobile
WHITEOVEN_TENANT=pizzaria-centro pnpm storybook
```

Leia o QR code com a câmera do iPhone, como no `pnpm start`. Em vez do app, abre o Storybook: cada story ocupa a tela, e a barra de baixo mostra o nome dela. O ícone ☰ à esquerda abre a lista de stories; o ícone à direita abre os addons. Em **Controls** as props mudam ao vivo, e em **Actions** aparecem os toques (por exemplo, a configuração da pizza ao tocar em "Adicionar").

No navegador:

```sh
cd apps/mobile
WHITEOVEN_TENANT=pizzaria-centro pnpm storybook:web
```

A prévia web usa `react-native-web`: sombras, fontes, `Alert` e teclado diferem do iOS. Para validar o visual final, use o iPhone.

`pnpm storybook` limpa o cache do Metro ao iniciar. Ao voltar para o app, rode `pnpm start --clear` uma vez.

## O que tem

| Grupo         | Stories                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Design system | Button (variantes, tipografia, cards, campos), AppBar e chips, Icon (catálogo), InlineMessage e toast, Choice, QuantityStepper, SegmentedControl, ListRow e totais, StatusBadge, PizzaVisual, ScreenHeader, rodapé fixo e abas, LegalSheet |
| Telas         | Início, Cardápio, Monte sua pizza, Sacola, Pedidos e Acompanhar pedido, Conta (boas-vindas, entrar, criar conta, confirme seu e-mail), Loja indisponível                                                                                   |

Cada tela tem os estados que importam: carregando, erro, vazio, loja fechada, cardápio desatualizado, sem login e, nos pedidos, cada etapa do acompanhamento (recém-feito, em preparo, saiu para entrega, pronto para retirar, entregue, cancelado).

O Monte sua pizza guarda as etapas (Tamanho, Sabores, Borda, Adicionais) no próprio estado: navegue por elas dentro da story.

## Como funciona

- **Nada muda no app.** `index.ts` só registra o Storybook quando `EXPO_PUBLIC_STORYBOOK_ENABLED=true`. Em qualquer outra execução, o `metro.config.mjs` troca `.rnstorybook` e os pacotes `@storybook/*` por módulos vazios, e o bundle do app fica como antes.
- **Dados de demonstração.** `src/storybook/fixtures.ts` monta o cardápio, os pedidos e o cliente passando pelos mesmos parsers das respostas da API (`parseMenu`, `parseCustomerOrderDetail`). As telas que falam com a API recebem um modelo falso que responde com esses dados e não envia nada: entrar, confirmar, cancelar e pedir novamente não fazem efeito.
- **Mesmos provedores do app.** `.rnstorybook/preview.tsx` envolve cada story com Safe Area, o tema da loja (cores padrão do WhiteOven) e os toasts, como o `App.tsx`. `parameters.layout: "padded"` põe componentes pequenos sobre o fundo creme com margem; `parameters.aboveTabBar` simula a barra de abas abaixo da tela.
- **UI lite.** O Storybook usa `@storybook/react-native-ui-lite`, que dispensa bottom sheet na navegação. Os addons de controles ainda carregam `react-native-reanimated`, `react-native-gesture-handler` e `react-native-worklets`; as versões estão fixadas nas do Expo Go do SDK 58.
- **Builds de loja sem módulos nativos novos.** As dependências nativas que só o Storybook usa (AsyncStorage, slider, datetimepicker, reanimated, gesture handler, worklets e svg) estão em `expo.autolinking.exclude` no `package.json`. Os builds EAS continuam com os mesmos módulos nativos de antes (`expo` e `react-native-safe-area-context`). Por isso o Storybook roda no Expo Go, e não num build de preview.

## Adicionar uma story

Crie `NomeDoComponente.stories.tsx` ao lado do componente, em `src/`. O Metro encontra o arquivo sozinho ao rodar `pnpm storybook` e atualiza `.rnstorybook/storybook.requires.ts` (gerado, não edite). Fora do Metro, `pnpm storybook:generate` faz o mesmo.

```tsx
import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { MeuComponente } from "./MeuComponente.tsx";

const meta = {
  title: "Design system/MeuComponente",
  component: MeuComponente,
  parameters: { layout: "padded" },
  args: { label: "Exemplo", onPress: fn() },
} satisfies Meta<typeof MeuComponente>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Padrao: Story = {};
export const Desativado: Story = { args: { disabled: true } };
```

Use `fn()` para as callbacks aparecerem em Actions. Para dados, reaproveite `src/storybook/fixtures.ts`.
