import { provideHttpClient, withInterceptors } from "@angular/common/http";
import {
  type ApplicationConfig,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from "@angular/core";
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { routes } from "./app.routes";
import { authInterceptor } from "./core/auth.interceptor";
import { Session } from "./core/session";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideRouter(routes, withComponentInputBinding()),
    // Guards run after the refresh cookie had its chance to restore the session.
    provideAppInitializer(() => inject(Session).restore()),
  ],
};
