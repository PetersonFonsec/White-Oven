import {
  HttpTestingController,
  type TestRequest,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from "@angular/common/http";
import { TestBed } from "@angular/core/testing";
import { Router, provideRouter } from "@angular/router";
import { firstValueFrom } from "rxjs";
import { AUTH } from "./api";
import { authInterceptor } from "./auth.interceptor";
import { LOGOUT_PENDING_KEY, Session, SupersededError } from "./session";

const CENTRO = "11111111-1111-4111-8111-111111111111";
const BAIRRO = "22222222-2222-4222-8222-222222222222";
const tokens = (accessToken: string, activeTenantId: string | null = null) => ({
  accessToken,
  tokenType: "Bearer",
  expiresIn: 900,
  activeTenantId,
});
const choice = (tenantId: string, displayName: string) => ({
  tenantId,
  slug: displayName.toLowerCase(),
  displayName,
  role: "OWNER" as const,
});
const forbidden = { status: 403, statusText: "Forbidden" };
const unauthorized = { status: 401, statusText: "Unauthorized" };
const expired = { code: "UNAUTHORIZED", message: "x" };

describe("Session", () => {
  let session: Session;
  let http: HttpTestingController;
  let client: HttpClient;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    session = TestBed.inject(Session);
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
    navigate = vi
      .spyOn(TestBed.inject(Router), "navigateByUrl")
      .mockResolvedValue(true);
  });
  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  /**
   * Runs queued promise callbacks until `count` requests to `url` were issued. Deterministic: no
   * timers, only microtasks, and it fails instead of waiting when the requests never come.
   */
  const next = async (url: string, count = 1): Promise<TestRequest[]> => {
    const found: TestRequest[] = [];
    for (let turn = 0; turn < 200 && found.length < count; turn++) {
      found.push(...http.match(url));
      if (found.length < count) await Promise.resolve();
    }
    expect(found.length).toBe(count);
    return found;
  };
  const one = async (url: string) => (await next(url))[0]!;
  /** Lets every queued promise callback run. */
  const drain = async () => {
    for (let turn = 0; turn < 200; turn++) await Promise.resolve();
  };
  const notOperator = async (token?: string) => {
    const request = await one(AUTH.platformMe);
    if (token)
      expect(request.request.headers.get("authorization")).toBe(
        `Bearer ${token}`,
      );
    request.flush({ code: "PLATFORM_FORBIDDEN" }, forbidden);
  };
  const storeLoads = async (tenantId: string, token?: string) => {
    const me = await one(AUTH.adminMe);
    const tenants = await one(AUTH.tenants);
    if (token)
      for (const request of [me, tenants])
        expect(request.request.headers.get("authorization")).toBe(
          `Bearer ${token}`,
        );
    return {
      me,
      tenants,
      flush: () => {
        me.flush({ tenantId, role: "OWNER" });
        tenants.flush([choice(CENTRO, "Centro"), choice(BAIRRO, "Bairro")]);
      },
    };
  };
  const signIn = async (token: string, tenantId: string | null = null) => {
    const login = session.login("dona@pizzaria.test", "senha-segura");
    (await one(AUTH.login)).flush(tokens(token, tenantId));
    await notOperator();
    if (tenantId) (await storeLoads(tenantId)).flush();
    expect(await login).toBe("signed-in");
  };
  const tenantsCall = () => firstValueFrom(client.get<unknown[]>(AUTH.tenants));

  describe("sign-in", () => {
    it("keeps the access token in memory only and sends it as a bearer token", async () => {
      const login = session.login("dona@pizzaria.test", "senha-segura");
      const request = await one(AUTH.login);
      expect(request.request.headers.has("authorization")).toBe(false);
      request.flush(tokens("token-1"));
      await notOperator("token-1");
      expect(await login).toBe("signed-in");
      expect(session.signedIn()).toBe(true);
      expect(session.platform()).toBe("none");
      expect(localStorage.length).toBe(0);
      expect(sessionStorage.length).toBe(0);
      expect(document.cookie).toBe("");

      const tenants = session.tenants();
      const listed = await one(AUTH.tenants);
      expect(listed.request.headers.get("authorization")).toBe(
        "Bearer token-1",
      );
      listed.flush([]);
      expect(await tenants).toEqual([]);
    });

    it("signs in with the second factor after the MFA challenge", async () => {
      const login = session.login("dona@pizzaria.test", "senha-segura");
      (await one(AUTH.login)).flush({
        mfaRequired: true,
        mfaToken: "challenge",
        expiresIn: 300,
      });
      expect(await login).toEqual({ mfaToken: "challenge" });
      expect(session.signedIn()).toBe(false);

      const verify = session.loginMfa("challenge", {
        recoveryCode: "abcde-fghij",
      });
      const request = await one(AUTH.loginMfa);
      expect(request.request.body).toEqual({
        mfaToken: "challenge",
        recoveryCode: "abcde-fghij",
      });
      request.flush(tokens("token-2", CENTRO));
      await notOperator("token-2");
      const loads = await storeLoads(CENTRO, "token-2");
      expect(session.signedIn()).toBe(false);
      loads.flush();
      await verify;
      expect(session.signedIn()).toBe(true);
      expect(session.store()?.tenantId).toBe(CENTRO);
    });

    it("does not sign in when a logout happens while the second factor is checked", async () => {
      const verify = session.loginMfa("challenge", { code: "123456" });
      const request = await one(AUTH.loginMfa);
      const logout = session.logout();
      (await one(AUTH.logout)).flush(null);
      expect(await logout).toBe("confirmed");
      request.flush(tokens("late"));
      await expect(verify).rejects.toBeInstanceOf(SupersededError);
      expect(session.signedIn()).toBe(false);
      expect(session.accessToken()).toBeNull();
      // Superseded before loading anything: no request with the late token.
      http.expectNone(AUTH.platformMe);
    });

    it("sends an operator without the second factor to enrollment", async () => {
      const login = session.login("operador@whiteoven.test", "senha-segura");
      (await one(AUTH.login)).flush(tokens("token-4", CENTRO));
      (await one(AUTH.platformMe)).flush({ code: "MFA_REQUIRED" }, forbidden);
      await login;
      expect(session.platform()).toBe("mfa-setup");
      // The API refuses store routes before enrollment; they are not even asked.
      http.expectNone(AUTH.adminMe);
      expect(session.store()).toBeNull();
    });
  });

  describe("publishing a session", () => {
    it("publishes token, platform and store together, only after every load", async () => {
      const restore = session.restore();
      const refresh = await one(AUTH.refresh);
      expect(refresh.request.method).toBe("POST");
      expect(refresh.request.headers.has("authorization")).toBe(false);
      refresh.flush(tokens("token-3", CENTRO));
      await notOperator("token-3");
      const loads = await storeLoads(CENTRO, "token-3");
      loads.me.flush({ tenantId: CENTRO, role: "MANAGER" });
      await drain();
      // Half-loaded: nothing is visible yet.
      expect(session.signedIn()).toBe(false);
      expect(session.accessToken()).toBeNull();
      loads.tenants.flush([choice(CENTRO, "Centro")]);
      await restore;
      expect(session.accessToken()).toBe("token-3");
      expect(session.store()?.displayName).toBe("Centro");
      expect(session.role()).toBe("MANAGER");
    });

    it("publishes nothing when loading the permissions fails", async () => {
      const login = session.login("dona@pizzaria.test", "senha-segura");
      (await one(AUTH.login)).flush(tokens("token-6", CENTRO));
      await notOperator();
      const loads = await storeLoads(CENTRO);
      loads.me.flush(
        { code: "INTERNAL", message: "x" },
        { status: 500, statusText: "Server Error" },
      );
      loads.tenants.flush([]);
      await expect(login).rejects.toBeTruthy();
      expect(session.signedIn()).toBe(false);
      expect(session.platform()).toBeNull();
      expect(session.store()).toBeNull();
    });

    it("leaves no store selected when the active store refuses access", async () => {
      const login = session.login("dona@pizzaria.test", "senha-segura");
      (await one(AUTH.login)).flush(tokens("token-7", CENTRO));
      await notOperator();
      const loads = await storeLoads(CENTRO);
      loads.me.flush({ code: "TENANT_ACCESS_DENIED" }, forbidden);
      loads.tenants.flush([]);
      await login;
      expect(session.signedIn()).toBe(true);
      expect(session.store()).toBeNull();
    });

    it("ends signed out when there is no refresh cookie", async () => {
      const restore = session.restore();
      (await one(AUTH.refresh)).flush(expired, unauthorized);
      await restore;
      expect(session.signedIn()).toBe(false);
    });

    it("ends signed out, not half signed in, when a refresh cannot load the permissions", async () => {
      const restore = session.restore();
      (await one(AUTH.refresh)).flush(tokens("token-8"));
      (await one(AUTH.platformMe)).error(new ProgressEvent("error"));
      await restore;
      expect(session.signedIn()).toBe(false);
      expect(session.accessToken()).toBeNull();
    });
  });

  describe("refresh", () => {
    it("renews an expired token once, with a single refresh for concurrent calls", async () => {
      await signIn("old");
      const first = tenantsCall();
      const second = tenantsCall();
      for (const request of await next(AUTH.tenants, 2))
        request.flush(expired, unauthorized);
      (await one(AUTH.refresh)).flush(tokens("new"));
      await notOperator("new");
      const retried = await next(AUTH.tenants, 2);
      for (const request of retried) {
        expect(request.request.headers.get("authorization")).toBe("Bearer new");
        request.flush([]);
      }
      expect(await first).toEqual([]);
      expect(await second).toEqual([]);
      http.expectNone(AUTH.refresh);
    });

    it("does not restore the session when the refresh ends after the logout", async () => {
      await signIn("old");
      const refreshed = session.refresh();
      const refresh = await one(AUTH.refresh);
      const logout = session.logout();
      expect(session.signedIn()).toBe(false);
      // The logout waits for the refresh, so it carries the rotated cookie.
      http.expectNone(AUTH.logout);
      refresh.flush(tokens("late"));
      expect(await refreshed).toEqual({ status: "superseded" });
      (await one(AUTH.logout)).flush(null);
      expect(await logout).toBe("confirmed");
      expect(session.signedIn()).toBe(false);
      expect(session.accessToken()).toBeNull();
      http.expectNone(AUTH.platformMe);
    });

    it("does not retry calls waiting on a refresh that a logout made obsolete", async () => {
      await signIn("old");
      const first = tenantsCall();
      const second = tenantsCall();
      for (const request of await next(AUTH.tenants, 2))
        request.flush(expired, unauthorized);
      const refresh = await one(AUTH.refresh);
      const logout = session.logout();
      refresh.flush(tokens("late"));
      await expect(first).rejects.toMatchObject({ status: 401 });
      await expect(second).rejects.toMatchObject({ status: 401 });
      (await one(AUTH.logout)).flush(null);
      await logout;
      http.expectNone(AUTH.tenants);
      http.expectNone(AUTH.refresh);
      expect(session.accessToken()).toBeNull();
    });

    it("keeps a new sign-in when an older refresh finishes later", async () => {
      await signIn("old");
      const refreshed = session.refresh();
      const refresh = await one(AUTH.refresh);
      const login = session.login("outra@pizzaria.test", "senha-segura");
      (await one(AUTH.login)).flush(tokens("fresh"));
      await notOperator("fresh");
      await login;
      refresh.flush(tokens("stale"));
      expect(await refreshed).toEqual({ status: "superseded" });
      expect(session.accessToken()).toBe("fresh");
      http.expectNone(AUTH.platformMe);
    });

    it("starts a new refresh only after an obsolete one settles, and keeps it", async () => {
      await signIn("old");
      const stale = session.refresh();
      const firstRefresh = await one(AUTH.refresh);
      const login = session.login("dona@pizzaria.test", "senha-segura");
      (await one(AUTH.login)).flush(tokens("fresh"));
      await notOperator();
      await login;

      const renewal = session.refresh();
      expect(session.refresh()).toBe(renewal);
      // Never two refreshes in flight: the API would treat the second as token theft.
      await drain();
      http.expectNone(AUTH.refresh);
      firstRefresh.flush(tokens("stale"));
      expect(await stale).toEqual({ status: "superseded" });
      (await one(AUTH.refresh)).flush(tokens("renewed"));
      await notOperator();
      expect(await renewal).toMatchObject({ status: "renewed" });
      expect(session.accessToken()).toBe("renewed");
      // The settled stale refresh did not drop the new one.
      expect(session.refresh()).not.toBe(renewal);
      (await one(AUTH.refresh)).flush(tokens("again"));
      await notOperator();
      await drain();
    });

    it("keeps a store switch when an older refresh finishes later", async () => {
      await signIn("centro", CENTRO);
      const refreshed = session.refresh();
      const refresh = await one(AUTH.refresh);
      const switched = session.selectStore(BAIRRO);
      const request = await one(AUTH.activeTenant);
      expect(request.request.headers.get("authorization")).toBe(
        "Bearer centro",
      );
      request.flush(tokens("bairro", BAIRRO));
      await notOperator("bairro");
      (await storeLoads(BAIRRO, "bairro")).flush();
      await switched;
      refresh.flush(tokens("centro-2", CENTRO));
      expect(await refreshed).toEqual({ status: "superseded" });
      expect(session.store()?.tenantId).toBe(BAIRRO);
      expect(session.accessToken()).toBe("bairro");
    });

    it("keeps a store switch over a refresh started while it was pending", async () => {
      await signIn("centro", CENTRO);
      const switched = session.selectStore(BAIRRO);
      const request = await one(AUTH.activeTenant);
      const refreshed = session.refresh();
      const refresh = await one(AUTH.refresh);
      request.flush(tokens("bairro", BAIRRO));
      await notOperator();
      (await storeLoads(BAIRRO)).flush();
      await switched;
      // The refresh read the session before the switch and carries the previous store.
      refresh.flush(tokens("centro-2", CENTRO));
      expect(await refreshed).toEqual({ status: "superseded" });
      expect(session.store()?.tenantId).toBe(BAIRRO);
    });
  });

  describe("interceptor", () => {
    it("does not retry a call of the previous store with the new store's token", async () => {
      await signIn("centro", CENTRO);
      const call = tenantsCall();
      const sent = await one(AUTH.tenants);
      expect(sent.request.headers.get("authorization")).toBe("Bearer centro");
      const switched = session.selectStore(BAIRRO);
      (await one(AUTH.activeTenant)).flush(tokens("bairro", BAIRRO));
      await notOperator();
      (await storeLoads(BAIRRO)).flush();
      await switched;
      sent.flush(expired, unauthorized);
      await expect(call).rejects.toMatchObject({ status: 401 });
      http.expectNone(AUTH.tenants);
      http.expectNone(AUTH.refresh);
    });

    it("reuses a token another call already renewed instead of refreshing again", async () => {
      await signIn("old");
      const early = tenantsCall();
      const slow = tenantsCall();
      const [earlyRequest, slowRequest] = await next(AUTH.tenants, 2);
      earlyRequest!.flush(expired, unauthorized);
      (await one(AUTH.refresh)).flush(tokens("new"));
      await notOperator();
      (await one(AUTH.tenants)).flush([]);
      await early;
      slowRequest!.flush(expired, unauthorized);
      const retried = await one(AUTH.tenants);
      expect(retried.request.headers.get("authorization")).toBe("Bearer new");
      retried.flush([]);
      await slow;
      http.expectNone(AUTH.refresh);
    });

    it("sends the person to the sign-in page when the refresh fails", async () => {
      await signIn("old");
      const call = tenantsCall();
      (await one(AUTH.tenants)).flush(expired, unauthorized);
      (await one(AUTH.refresh)).flush(
        { code: "SESSION_INVALID", message: "x" },
        unauthorized,
      );
      await expect(call).rejects.toMatchObject({ status: 401 });
      expect(navigate).toHaveBeenCalledWith("/entrar");
      expect(session.signedIn()).toBe(false);
    });
  });

  describe("logout", () => {
    it("ends the session when the API confirms the logout", async () => {
      await signIn("token-5");
      const logout = session.logout();
      expect(session.accessToken()).toBeNull();
      (await one(AUTH.logout)).flush(null);
      expect(await logout).toBe("confirmed");
      expect(session.logoutUnconfirmed()).toBe(false);
      expect(localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    });

    it("forgets the token on a network failure and says the logout is unconfirmed", async () => {
      await signIn("token-5");
      const logout = session.logout();
      (await one(AUTH.logout)).error(new ProgressEvent("error"));
      expect(await logout).toBe("unconfirmed");
      expect(session.signedIn()).toBe(false);
      expect(session.accessToken()).toBeNull();
      expect(session.logoutUnconfirmed()).toBe(true);
      // Only a non-secret marker is kept: no token reaches storage.
      expect(localStorage.getItem(LOGOUT_PENDING_KEY)).toBe("1");
      expect(JSON.stringify({ ...localStorage })).not.toContain("token-5");
    });

    it("after an unconfirmed logout, a reload retries the logout instead of resuming", async () => {
      localStorage.setItem(LOGOUT_PENDING_KEY, "1");
      session = TestBed.runInInjectionContext(() => new Session());
      expect(session.logoutUnconfirmed()).toBe(true);
      const restore = session.restore();
      (await one(AUTH.logout)).flush(null);
      await restore;
      http.expectNone(AUTH.refresh);
      expect(session.signedIn()).toBe(false);
      expect(session.logoutUnconfirmed()).toBe(false);
      expect(localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    });

    it("stays signed out on reload while the logout still cannot be confirmed", async () => {
      localStorage.setItem(LOGOUT_PENDING_KEY, "1");
      const restore = session.restore();
      (await one(AUTH.logout)).error(new ProgressEvent("error"));
      await restore;
      http.expectNone(AUTH.refresh);
      expect(session.signedIn()).toBe(false);
      expect(session.logoutUnconfirmed()).toBe(true);

      // Signing in again replaces the cookie in this browser and drops the warning.
      await signIn("token-9");
      expect(session.logoutUnconfirmed()).toBe(false);
      expect(localStorage.getItem(LOGOUT_PENDING_KEY)).toBeNull();
    });
  });
});
