import type { Routes } from "@angular/router";
import { LoginPage } from "./auth/login.page";
import { MfaSetupPage } from "./auth/mfa-setup.page";
import {
  enrollingMfa,
  landing,
  operator,
  roleAllowed,
  signedIn,
  signedOut,
  storeSelected,
} from "./core/guards";
import { PlatformHomePage } from "./platform/platform-home.page";
import { rolesOf } from "./shell/navigation";
import { StoreHomePage } from "./shell/store-home.page";
import { StoreShell } from "./shell/store-shell";
import { UpcomingPage } from "./shell/upcoming.page";
import { StoreSelectPage } from "./stores/store-select.page";

export const routes: Routes = [
  {
    path: "",
    pathMatch: "full",
    canActivate: [signedIn, landing],
    children: [],
  },
  {
    path: "entrar",
    title: "Entrar · WhiteOven",
    canActivate: [signedOut],
    component: LoginPage,
  },
  {
    path: "seguranca/mfa",
    title: "Verificação em duas etapas · WhiteOven",
    canActivate: [signedIn, enrollingMfa],
    component: MfaSetupPage,
  },
  {
    path: "lojas",
    title: "Lojas · WhiteOven",
    canActivate: [signedIn],
    component: StoreSelectPage,
  },
  {
    path: "plataforma",
    title: "Plataforma · WhiteOven",
    canActivate: [signedIn, operator],
    component: PlatformHomePage,
  },
  {
    path: "loja",
    canActivate: [signedIn, storeSelected],
    canActivateChild: [roleAllowed],
    component: StoreShell,
    children: [
      {
        path: "",
        title: "Início · WhiteOven",
        data: { roles: rolesOf("") },
        component: StoreHomePage,
      },
      {
        path: "cardapio",
        title: "Cardápio · WhiteOven",
        data: { roles: rolesOf("cardapio"), title: "Cardápio" },
        component: UpcomingPage,
      },
      {
        path: "equipe",
        title: "Equipe · WhiteOven",
        data: { roles: rolesOf("equipe"), title: "Equipe" },
        component: UpcomingPage,
      },
    ],
  },
  { path: "**", redirectTo: "" },
];
