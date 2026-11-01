import type { Meta, StoryObj } from "@storybook/react-native";
import { fn } from "storybook/test";
import { InlineMessage } from "../components/Feedback.tsx";
import {
  STORE_NAME,
  baseState,
  heroImageUrl,
  legalReady,
  storyModel,
} from "../storybook/fixtures.ts";
import { AuthFlow, BrandMark, ConfirmEmailScreen } from "./AuthScreens.tsx";

/**
 * Boas-vindas, Entrar e Criar conta, as the app opens them. The steps move inside the story;
 * submitting does not call the API.
 */
const meta = {
  title: "Telas/Conta (entrar e cadastro)",
  component: AuthFlow,
  args: {
    model: storyModel(),
    state: baseState,
    initial: "welcome",
    legal: legalReady,
    storeName: STORE_NAME,
    logoUrl: null,
    heroImageUrl,
    backTo: null,
    notice: null,
    problems: null,
    onReloadLegal: async () => legalReady,
    onExit: undefined,
    onSkip: fn(),
  },
  argTypes: {
    initial: {
      control: "select",
      options: ["welcome", "login", "register", "confirm-email"],
    },
  },
  render: (args) => <AuthFlow key={args.initial} {...args} />,
} satisfies Meta<typeof AuthFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BoasVindas: Story = {};
export const BoasVindasSemFoto: Story = { args: { heroImageUrl: null } };
export const Entrar: Story = {
  args: { initial: "login", backTo: "Sacola", onExit: fn() },
};
export const EntrarComAviso: Story = {
  args: {
    initial: "login",
    notice: "Entre para acompanhar o pedido da notificação.",
  },
};
export const EntrarEnviando: Story = {
  args: { initial: "login", state: { ...baseState, busy: true } },
};
export const EntrarComErro: Story = {
  args: {
    initial: "login",
    state: { ...baseState, error: "E-mail ou senha incorretos." },
  },
};
export const CriarConta: Story = { args: { initial: "register" } };
export const CriarContaTermosCarregando: Story = {
  args: { initial: "register", legal: { status: "loading" } },
};
export const CriarContaSemTermos: Story = {
  args: { initial: "register", legal: { status: "unavailable" } },
};
export const ComProblemaDeSessao: Story = {
  args: {
    problems: (
      <InlineMessage tone="error" title="Não foi possível abrir sua sessão">
        Tente de novo em instantes.
      </InlineMessage>
    ),
  },
};

export const ConfirmeSeuEmail: StoryObj<typeof ConfirmEmailScreen> = {
  render: () => (
    <ConfirmEmailScreen
      email="maria@exemplo.com"
      onOpenMail={() => {}}
      onResend={() => {}}
      onBack={() => {}}
    />
  ),
};

export const MarcaDaLoja: StoryObj<typeof BrandMark> = {
  parameters: { layout: "padded" },
  render: () => (
    <>
      <BrandMark name={STORE_NAME} logoUrl={null} />
      <BrandMark name="Pizzaria Centro" logoUrl={null} compact />
    </>
  ),
};
