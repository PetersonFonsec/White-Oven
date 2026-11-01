import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { fn } from "storybook/test";
import {
  Body,
  Button,
  Divider,
  Field,
  FormPage,
  Heading,
  SurfaceCard,
} from "./Form.tsx";

const meta = {
  title: "Design system/Button",
  component: Button,
  parameters: { layout: "padded" },
  args: {
    label: "Adicionar à sacola",
    onPress: fn(),
    variant: "primary",
    size: "large",
    disabled: false,
    loading: false,
  },
  argTypes: {
    variant: {
      control: "select",
      options: [
        "primary",
        "secondary",
        "outline",
        "neutral",
        "ghost",
        "destructive",
      ],
    },
    size: { control: "select", options: ["small", "medium", "large"] },
  },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {};
export const WithIcon: Story = { args: { icon: "bag-handle-outline" } };
export const Loading: Story = { args: { loading: true } };
export const Disabled: Story = { args: { disabled: true } };
export const Outline: Story = {
  args: { variant: "outline", label: "Pedir novamente" },
};
export const Neutral: Story = {
  args: {
    variant: "neutral",
    label: "Continuar com Google",
    icon: "logo-google",
  },
};
export const Ghost: Story = { args: { variant: "ghost", label: "Agora não" } };
export const Destructive: Story = {
  args: { variant: "destructive", label: "Cancelar pedido" },
};

/** Every variant and size side by side. */
export const AllVariants: Story = {
  render: (args) => (
    <>
      {(
        [
          "primary",
          "secondary",
          "outline",
          "neutral",
          "ghost",
          "destructive",
        ] as const
      ).map((variant) => (
        <Button key={variant} {...args} variant={variant} label={variant} />
      ))}
      <Button {...args} size="medium" label="Médio" />
      <Button {...args} size="small" label="Pequeno" />
    </>
  ),
};

export const Typography: Story = {
  render: () => (
    <>
      <Heading level="display">Display</Heading>
      <Heading level="h1">Título h1</Heading>
      <Heading level="h2">Título h2</Heading>
      <Heading level="h3">Título h3</Heading>
      <Heading level="title">Title</Heading>
      <Body>Corpo do texto, como nas descrições do cardápio.</Body>
      <Body small>Corpo pequeno, para detalhes.</Body>
      <Body muted>Corpo esmaecido, para textos de apoio.</Body>
      <Body alert>Corpo de alerta, para erros.</Body>
    </>
  ),
};

export const Cards: Story = {
  render: () => (
    <>
      <SurfaceCard>
        <Heading level="title">Superfície</Heading>
        <Body muted>tone = surface</Body>
      </SurfaceCard>
      <SurfaceCard tone="secondary">
        <Heading level="title">Secundária</Heading>
        <Body muted>tone = secondary</Body>
      </SurfaceCard>
      <SurfaceCard tone="outlined">
        <Heading level="title">Contornada</Heading>
        <Divider />
        <Body muted>tone = outlined, com um Divider acima</Body>
      </SurfaceCard>
    </>
  ),
};

function FieldsDemo() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("segredo123");
  const [cep, setCep] = useState("0131");
  return (
    <FormPage
      header={<Heading level="h2">Campos</Heading>}
      footer={<Button label="Enviar" onPress={() => {}} />}
    >
      <Field
        label="E-mail"
        icon="mail-outline"
        value={email}
        onChangeText={setEmail}
        placeholder="voce@exemplo.com"
        helper="Usamos para enviar o recibo."
        keyboardType="email-address"
        autoCapitalize="none"
      />
      <Field
        label="Senha"
        icon="lock-closed-outline"
        value={password}
        onChangeText={setPassword}
        password
      />
      <Field
        label="CEP"
        icon="location-outline"
        value={cep}
        onChangeText={setCep}
        error="Informe os 8 dígitos do CEP."
        keyboardType="number-pad"
        doneBar
      />
      <Field
        label="Observações"
        inlineLabel
        value=""
        onChangeText={() => {}}
        placeholder="Ex.: tocar o interfone"
      />
    </FormPage>
  );
}

export const Fields: Story = {
  parameters: { layout: "fullscreen" },
  render: () => <FieldsDemo />,
};
