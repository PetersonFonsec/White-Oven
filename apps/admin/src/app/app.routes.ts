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
import {
  InviteCompletePage,
  InviteRedemptionPage,
} from "./platform/invite-redemption.page";
import { rolesOf } from "./shell/navigation";
import { StoreHomePage } from "./shell/store-home.page";
import { StoreShell } from "./shell/store-shell";
import { StoreSelectPage } from "./stores/store-select.page";
import { BrandPage } from "./settings/brand.page";
import { SettingsPage } from "./settings/settings.page";
import { MenuPage } from "./catalog/menu.page";

/** Pages only some people open load on demand, keeping the initial bundle in its budget. */
const teamInvitePage = () =>
  import("./team/team-invite.page").then((m) => m.TeamInvitePage);

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
    path: "invite/concluido",
    title: "Conta criada · WhiteOven",
    component: InviteCompletePage,
  },
  {
    path: "invite/aceitar",
    title: "Aceitar convite · WhiteOven",
    canActivate: [signedOut],
    component: InviteRedemptionPage,
  },
  {
    path: "invite/:token",
    title: "Aceitar convite · WhiteOven",
    canActivate: [signedOut],
    component: InviteRedemptionPage,
  },
  {
    // Open to anyone with the link: a signed-in person may join another store's team too.
    path: "equipe/convite/aceitar",
    title: "Convite para a equipe · WhiteOven",
    loadComponent: teamInvitePage,
  },
  {
    path: "equipe/convite/:token",
    title: "Convite para a equipe · WhiteOven",
    loadComponent: teamInvitePage,
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
        component: MenuPage,
      },
      {
        path: "configuracoes",
        title: "Configurações · WhiteOven",
        data: { roles: rolesOf("configuracoes"), title: "Configurações" },
        component: SettingsPage,
      },
      {
        path: "marca",
        title: "Marca · WhiteOven",
        data: { roles: rolesOf("marca"), title: "Marca" },
        component: BrandPage,
      },
      {
        path: "equipe",
        title: "Equipe · WhiteOven",
        data: { roles: rolesOf("equipe"), title: "Equipe" },
        loadComponent: () => import("./team/team.page").then((m) => m.TeamPage),
      },
    ],
  },
  { path: "**", redirectTo: "" },
];
