import { TestBed } from "@angular/core/testing";
import {
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
  UrlTree,
  provideRouter,
} from "@angular/router";
import { landing, roleAllowed, signedIn } from "./guards";
import { type PlatformAccess, Session, type TenantChoice } from "./session";

const state = (url: string) => ({ url }) as RouterStateSnapshot;
const route = (roles?: string[]) =>
  ({ data: roles ? { roles } : {} }) as unknown as ActivatedRouteSnapshot;
const store = (role: TenantChoice["role"]): TenantChoice => ({
  tenantId: "t",
  slug: "loja",
  displayName: "Loja",
  role,
});

describe("guards", () => {
  let session: Session;
  const run = (guard: typeof signedIn, url = "/loja", roles?: string[]) => {
    const result = TestBed.runInInjectionContext(() =>
      guard(route(roles), state(url)),
    );
    return result instanceof UrlTree ? result.toString() : result;
  };
  const signIn = (platform: PlatformAccess, role?: TenantChoice["role"]) => {
    (session as unknown as { token: { set(v: string): void } }).token.set("t");
    session.platform.set(platform);
    session.store.set(role ? store(role) : null);
  };

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
    session = TestBed.inject(Session);
  });

  it("sends anonymous visitors to the sign-in page", () => {
    expect(run(signedIn)).toBe("/entrar");
  });

  it("keeps an operator without the second factor on enrollment", () => {
    signIn("mfa-setup");
    expect(run(signedIn, "/lojas")).toBe("/seguranca/mfa");
    expect(run(signedIn, "/seguranca/mfa")).toBe(true);
  });

  it("starts operators on the platform and staff on their store or the store list", () => {
    signIn("operator");
    expect(run(landing)).toBe("/plataforma");
    signIn("none", "STAFF");
    expect(run(landing)).toBe("/loja");
    signIn("none");
    expect(run(landing)).toBe("/lojas");
  });

  it("opens a section only for the roles in its route data", () => {
    signIn("none", "STAFF");
    expect(run(roleAllowed, "/loja/cardapio", ["OWNER", "MANAGER"])).toBe(
      "/loja",
    );
    expect(run(roleAllowed, "/loja", ["OWNER", "MANAGER", "STAFF"])).toBe(true);
    signIn("none", "MANAGER");
    expect(run(roleAllowed, "/loja/cardapio", ["OWNER", "MANAGER"])).toBe(true);
    expect(run(roleAllowed, "/loja/equipe", ["OWNER"])).toBe("/loja");
  });
});
