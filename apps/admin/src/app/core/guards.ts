import { inject } from "@angular/core";
import { type CanActivateFn, Router } from "@angular/router";
import { type Role, Session } from "./session";

/** Signed in, and an operator without the second factor goes only to its enrollment. */
export const signedIn: CanActivateFn = (_route, state) => {
  const session = inject(Session);
  const router = inject(Router);
  if (!session.signedIn()) return router.parseUrl("/entrar");
  if (session.platform() === "mfa-setup" && state.url !== "/seguranca/mfa")
    return router.parseUrl("/seguranca/mfa");
  return true;
};

export const signedOut: CanActivateFn = () =>
  inject(Session).signedIn() ? inject(Router).parseUrl("/") : true;

/** Where a signed-in person starts. */
export const landing: CanActivateFn = () => {
  const session = inject(Session);
  const router = inject(Router);
  if (session.platform() === "operator") return router.parseUrl("/plataforma");
  if (session.store()) return router.parseUrl("/loja");
  return router.parseUrl("/lojas");
};

export const storeSelected: CanActivateFn = () =>
  inject(Session).store() ? true : inject(Router).parseUrl("/lojas");

/** Route data `roles`: the store roles that may open it. The API enforces the same roles. */
export const roleAllowed: CanActivateFn = (route) => {
  const roles = route.data["roles"] as readonly Role[] | undefined;
  const role = inject(Session).role();
  return !roles || (role !== null && roles.includes(role))
    ? true
    : inject(Router).parseUrl("/loja");
};

export const operator: CanActivateFn = () =>
  inject(Session).platform() === "operator"
    ? true
    : inject(Router).parseUrl("/");

export const enrollingMfa: CanActivateFn = () =>
  inject(Session).platform() === "mfa-setup"
    ? true
    : inject(Router).parseUrl("/");
