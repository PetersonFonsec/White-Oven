import { registerRootComponent } from "expo";
import App from "./App.tsx";
import Storybook from "./.rnstorybook/index.tsx";

// Registers the root component for Expo Go and for native builds alike. `pnpm storybook` opens
// the component catalog instead of the app; in any other run Metro replaces `.rnstorybook` with
// an empty stub (metro.config.cjs), so the app bundle does not carry Storybook.
registerRootComponent(
  process.env.EXPO_PUBLIC_STORYBOOK_ENABLED === "true" ? Storybook : App,
);
