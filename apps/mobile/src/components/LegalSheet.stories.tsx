import type { Meta, StoryObj } from "@storybook/react-native";
import { useState } from "react";
import { fn } from "storybook/test";
import { legalReady } from "../storybook/fixtures.ts";
import { Button } from "./Form.tsx";
import { LegalSheet } from "./LegalSheet.tsx";

const terms =
  legalReady.status === "ready" ? legalReady.legal.termsOfUse : null;

const meta = {
  title: "Design system/LegalSheet",
  component: LegalSheet,
  parameters: { layout: "padded" },
  args: { title: "Termos de uso", document: terms, onClose: fn() },
} satisfies Meta<typeof LegalSheet>;

export default meta;
type Story = StoryObj<typeof meta>;

function SheetDemo() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button label="Abrir os termos" onPress={() => setOpen(true)} />
      <LegalSheet
        title="Termos de uso"
        document={open ? terms : null}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

/** Opens the sheet over the form; "Fechar" or swiping down closes it. */
export const OpenAndClose: Story = { render: () => <SheetDemo /> };
