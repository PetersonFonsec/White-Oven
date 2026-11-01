import type { Preview } from "@storybook/react-native";
import { ScrollView, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { DEFAULT_BRAND_COLORS } from "../src/brand/colors.ts";
import { ThemeProvider, themeFor } from "../src/brand/theme.tsx";
import { ToastProvider } from "../src/components/Feedback.tsx";
import { TabBarContext } from "../src/components/Screen.tsx";

const theme = themeFor(DEFAULT_BRAND_COLORS);

/**
 * Every story runs inside the same providers as `App.tsx`: safe areas, the store's theme (here
 * the WhiteOven defaults) and the toasts. `parameters.layout: "padded"` puts small components
 * on the cream background with the page gutter, scrolling; screens fill the whole story.
 * `parameters.aboveTabBar` tells the screens a tab bar is drawn below them, as in the main tabs.
 */
const preview: Preview = {
  decorators: [
    (Story, { parameters }) => (
      <SafeAreaProvider>
        <ThemeProvider value={theme}>
          <TabBarContext.Provider value={parameters.aboveTabBar === true}>
            <ToastProvider bottomOffset={0}>
              {parameters.layout === "padded" ? (
                <ScrollView
                  style={{ flex: 1, backgroundColor: theme.colors.background }}
                  contentContainerStyle={{ padding: 20, gap: 12 }}
                >
                  <Story />
                </ScrollView>
              ) : (
                <View
                  style={{ flex: 1, backgroundColor: theme.colors.background }}
                >
                  <Story />
                </View>
              )}
            </ToastProvider>
          </TabBarContext.Provider>
        </ThemeProvider>
      </SafeAreaProvider>
    ),
  ],
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
      },
    },
  },
};

export default preview;
