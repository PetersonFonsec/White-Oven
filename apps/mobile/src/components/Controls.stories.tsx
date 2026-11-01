import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { fn } from "storybook/test";
import { Choice } from "./Choice.tsx";
import { QuantityStepper } from "./QuantityStepper.tsx";
import { SegmentedControl } from "./SegmentedControl.tsx";

/** The selection controls of the builder and the bag. */
const meta = {
  title: "Design system/Choice",
  component: Choice,
  parameters: { layout: "padded" },
  args: {
    label: "Borda de catupiry",
    detail: "+ R$ 9,00",
    selected: false,
    disabled: false,
    kind: "radio",
    onPress: fn(),
  },
  argTypes: { kind: { control: "select", options: ["radio", "checkbox"] } },
} satisfies Meta<typeof Choice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Radio: Story = {};
export const RadioSelected: Story = { args: { selected: true } };
export const Checkbox: Story = {
  args: { kind: "checkbox", label: "Bacon", detail: "+ R$ 6,00" },
};
export const CheckboxSelected: Story = {
  args: {
    kind: "checkbox",
    label: "Bacon",
    detail: "+ R$ 6,00",
    selected: true,
  },
};
export const Disabled: Story = {
  args: { kind: "checkbox", label: "Milho", disabled: true },
};

function GroupDemo() {
  const [crust, setCrust] = useState("none");
  const [extras, setExtras] = useState<string[]>(["bacon"]);
  const toggle = (id: string) =>
    setExtras((list) =>
      list.includes(id) ? list.filter((x) => x !== id) : [...list, id],
    );
  return (
    <>
      {[
        ["none", "Sem borda", undefined],
        ["catupiry", "Catupiry", "+ R$ 9,00"],
        ["cheddar", "Cheddar", "+ R$ 9,00"],
      ].map(([id, label, detail]) => (
        <Choice
          key={id}
          kind="radio"
          label={label!}
          detail={detail}
          selected={crust === id}
          onPress={() => setCrust(id!)}
        />
      ))}
      {[
        ["bacon", "Bacon"],
        ["milho", "Milho"],
        ["parmesao", "Parmesão"],
      ].map(([id, label]) => (
        <Choice
          key={id}
          kind="checkbox"
          label={label!}
          detail="+ R$ 3,00"
          selected={extras.includes(id!)}
          onPress={() => toggle(id!)}
        />
      ))}
    </>
  );
}

/** A working group: one crust (radio) and several extras (checkbox). */
export const Group: Story = { render: () => <GroupDemo /> };

function StepperDemo({ disabled }: { disabled?: boolean }) {
  const [value, setValue] = useState(1);
  return (
    <QuantityStepper
      value={value}
      min={1}
      max={20}
      itemName="Calabresa"
      disabled={disabled}
      onChange={setValue}
    />
  );
}

export const Stepper: StoryObj<typeof QuantityStepper> = {
  render: () => (
    <>
      <StepperDemo />
      <StepperDemo disabled />
    </>
  ),
};

const modes = [
  { value: "WHOLE", label: "Inteira" },
  { value: "HALVES", label: "Meio a meio" },
] as const;

function SegmentedDemo({ disabled }: { disabled?: boolean }) {
  const [value, setValue] = useState<(typeof modes)[number]["value"]>("WHOLE");
  return (
    <SegmentedControl
      options={modes}
      value={value}
      onChange={setValue}
      disabled={disabled}
    />
  );
}

export const Segmented: StoryObj<typeof SegmentedControl> = {
  render: () => (
    <>
      <SegmentedDemo />
      <SegmentedDemo disabled />
    </>
  ),
};
