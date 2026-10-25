import { bootstrapApplication } from "@angular/platform-browser";
import { App } from "./app/app";
import { appConfig } from "./app/app.config";
import { applyDesignTokens } from "./app/core/design-tokens";

applyDesignTokens(document.documentElement);
bootstrapApplication(App, appConfig).catch((error: unknown) =>
  console.error(error),
);
