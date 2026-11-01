import { legalBlocks, type LegalDocument } from "@whiteoven/contracts";
import { Modal, View } from "react-native";
import { useTheme } from "../brand/theme.tsx";
import { Body, Button, Heading } from "./Form.tsx";
import { SafeAreaProvider } from "react-native-safe-area-context";
import {
  Screen,
  ScreenHeader,
  StickyFooter,
  TabBarContext,
} from "./Screen.tsx";

/**
 * One legal document in a sheet over the form (ADR 0030 blocks, escaped as text). Closing it
 * returns to the same place in the form; swiping it down on iOS also closes it.
 */
export function LegalSheet({
  title,
  document,
  onClose,
}: {
  title: string;
  document: LegalDocument | null;
  onClose: () => void;
}) {
  const theme = useTheme();
  return (
    <Modal
      visible={document !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
    >
      {document ? (
        // A sheet measures its own insets (no status bar above it) and has no tab bar below.
        <SafeAreaProvider>
          <TabBarContext.Provider value={false}>
            <Screen
              header={
                <ScreenHeader
                  title={title}
                  right={
                    <Button
                      label="Fechar"
                      variant="ghost"
                      size="small"
                      onPress={onClose}
                    />
                  }
                />
              }
              footer={
                <StickyFooter>
                  <Button label="Fechar" variant="primary" onPress={onClose} />
                </StickyFooter>
              }
              gap={theme.spacing(3)}
            >
              <Body small muted>
                Versão {document.version}
              </Body>
              {legalBlocks(document.body).map((block, index) =>
                block.type === "heading" ? (
                  <Heading key={index} level="h3">
                    {block.text}
                  </Heading>
                ) : block.type === "list" ? (
                  <View key={index} style={{ gap: 4 }}>
                    {block.items.map((item, at) => (
                      <Body key={at}>• {item}</Body>
                    ))}
                  </View>
                ) : (
                  <Body key={index}>{block.text}</Body>
                ),
              )}
            </Screen>
          </TabBarContext.Provider>
        </SafeAreaProvider>
      ) : null}
    </Modal>
  );
}
