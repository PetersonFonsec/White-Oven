// Metro config of the app. The only addition to Expo's default is Storybook (on-device), which
// only enters the bundle when `EXPO_PUBLIC_STORYBOOK_ENABLED=true` (`pnpm storybook`). Without
// it, every Storybook import resolves to an empty module and the app bundle stays as before.
import { join } from "node:path";
import { withStorybook } from "@storybook/react-native/metro/withStorybook";
import { getDefaultConfig } from "expo/metro-config";

const root = import.meta.dirname;

export default withStorybook(getDefaultConfig(root), {
  enabled: process.env.EXPO_PUBLIC_STORYBOOK_ENABLED === "true",
  configPath: join(root, ".rnstorybook"),
  // The lite UI needs no reanimated, gesture handler or bottom sheet, so it runs in Expo Go.
  liteMode: true,
});
