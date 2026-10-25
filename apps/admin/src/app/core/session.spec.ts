import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { provideHttpClient, withInterceptors } from "@angular/common/http";
import { TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { AUTH } from "./api";
import { authInterceptor } from "./auth.interceptor";
import { Session } from "./session";

const TENANT = "11111111-1111-4111-8111-111111111111";
const tokens = (accessToken: string, activeTenantId: string | null = null) => ({
  accessToken,
  tokenType: "Bearer",
  expiresIn: 900,
  activeTenantId,
});
const forbidden = { status: 403, statusText: "Forbidden" };
/** Lets pending promise chains issue their next HTTP request. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe("Session", () => {
  let session: Session;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([authInterceptor])),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    session = TestBed.inject(Session);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const flushNotOperator = async () => {
    await settle();
    http
      .expectOne(AUTH.platformMe)
      .flush({ code: "PLATFORM_FORBIDDEN" }, forbidden);
  };

  it("keeps the access token in memory only and sends it as a bearer token", async () => {
    const login = session.login("dona@pizzaria.test", "senha-segura");
    const request = http.expectOne(AUTH.login);
    expect(request.request.headers.has("authorization")).toBe(false);
    request.flush(tokens("token-1"));
    await flushNotOperator();
    expect(await login).toBe("signed-in");
    expect(session.signedIn()).toBe(true);
    expect(session.platform()).toBe("none");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(document.cookie).toBe("");

    const tenants = session.tenants();
    const listed = http.expectOne(AUTH.tenants);
    expect(listed.request.headers.get("authorization")).toBe("Bearer token-1");
    listed.flush([]);
    expect(await tenants).toEqual([]);
  });

  it("returns the MFA challenge without creating a session", async () => {
    const login = session.login("dona@pizzaria.test", "senha-segura");
    http
      .expectOne(AUTH.login)
      .flush({ mfaRequired: true, mfaToken: "challenge", expiresIn: 300 });
    expect(await login).toEqual({ mfaToken: "challenge" });
    expect(session.signedIn()).toBe(false);

    const verify = session.loginMfa("challenge", {
      recoveryCode: "abcde-fghij",
    });
    const request = http.expectOne(AUTH.loginMfa);
    expect(request.request.body).toEqual({
      mfaToken: "challenge",
      recoveryCode: "abcde-fghij",
    });
    request.flush(tokens("token-2"));
    await flushNotOperator();
    await verify;
    expect(session.signedIn()).toBe(true);
  });

  it("restores the active store from the refresh cookie on startup", async () => {
    const restore = session.restore();
    const refresh = http.expectOne(AUTH.refresh);
    expect(refresh.request.method).toBe("POST");
    expect(refresh.request.headers.has("authorization")).toBe(false);
    refresh.flush(tokens("token-3", TENANT));
    await flushNotOperator();
    await settle();
    http.expectOne(AUTH.adminMe).flush({ tenantId: TENANT, role: "MANAGER" });
    http.expectOne(AUTH.tenants).flush([
      {
        tenantId: TENANT,
        slug: "loja",
        displayName: "Loja Centro",
        role: "MANAGER",
      },
    ]);
    await restore;
    expect(session.store()?.displayName).toBe("Loja Centro");
    expect(session.role()).toBe("MANAGER");
  });

  it("ends signed out when there is no refresh cookie", async () => {
    const restore = session.restore();
    http
      .expectOne(AUTH.refresh)
      .flush(
        { code: "UNAUTHORIZED" },
        { status: 401, statusText: "Unauthorized" },
      );
    await restore;
    expect(session.signedIn()).toBe(false);
  });

  it("sends an operator without the second factor to enrollment", async () => {
    const login = session.login("operador@whiteoven.test", "senha-segura");
    http.expectOne(AUTH.login).flush(tokens("token-4"));
    await settle();
    http.expectOne(AUTH.platformMe).flush({ code: "MFA_REQUIRED" }, forbidden);
    await login;
    expect(session.platform()).toBe("mfa-setup");
  });

  it("renews an expired token once, with a single refresh for concurrent calls", async () => {
    const login = session.login("dona@pizzaria.test", "senha-segura");
    http.expectOne(AUTH.login).flush(tokens("old"));
    await flushNotOperator();
    await login;

    const first = session.tenants();
    const second = session.tenants();
    for (const request of http.match(AUTH.tenants))
      request.flush(
        { code: "UNAUTHORIZED" },
        { status: 401, statusText: "Unauthorized" },
      );
    await settle();
    http.expectOne(AUTH.refresh).flush(tokens("new"));
    await flushNotOperator();
    await settle();
    const retried = http.match(AUTH.tenants);
    expect(retried.length).toBe(2);
    for (const request of retried) {
      expect(request.request.headers.get("authorization")).toBe("Bearer new");
      request.flush([]);
    }
    expect(await first).toEqual([]);
    expect(await second).toEqual([]);
  });

  it("forgets everything on logout even if the API is unreachable", async () => {
    const login = session.login("dona@pizzaria.test", "senha-segura");
    http.expectOne(AUTH.login).flush(tokens("token-5"));
    await flushNotOperator();
    await login;
    const logout = session.logout();
    http.expectOne(AUTH.logout).error(new ProgressEvent("error"));
    await logout;
    expect(session.signedIn()).toBe(false);
    expect(session.accessToken()).toBeNull();
  });
});
