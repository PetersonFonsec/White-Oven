import AsyncStorage from "@react-native-async-storage/async-storage";
import { LiteUI } from "@storybook/react-native-ui-lite";
import { view } from "./storybook.requires.ts";

/**
 * Storybook on the device (`pnpm storybook`). The lite UI keeps the app free of reanimated and
 * gesture handler; AsyncStorage only remembers the last story opened.
 */
const StorybookUIRoot = view.getStorybookUI({
  CustomUIComponent: LiteUI,
  storage: {
    getItem: AsyncStorage.getItem,
    setItem: AsyncStorage.setItem,
  },
});

export default StorybookUIRoot;
