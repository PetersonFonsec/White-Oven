import { TestBed } from "@angular/core/testing";
import { provideHttpClient, withInterceptors } from "@angular/common/http";
import {
  HttpTestingController,
  provideHttpClientTesting,
} from "@angular/common/http/testing";
import { DEFAULT_BRAND_COLORS } from "@whiteoven/contracts";
import { StoreContext, readAvailability } from "./store-context";
import { publicApiInterceptor } from "../api/public-api";
const profile = (slug = "test-store") => ({
  slug,
  name: slug,
  brand: { version: 1, colors: DEFAULT_BRAND_COLORS, logoImageId: null },
});
const status = {
  open: true,
  reason: "OPEN",
  timezone: "America/Sao_Paulo",
  pausedUntil: null,
};
describe("store context", () => {
  let store: StoreContext;
  let http: HttpTestingController;
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        StoreContext,
        provideHttpClient(withInterceptors([publicApiInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    store = TestBed.inject(StoreContext);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());
  it("loads only public API data, validates identity and never caches status", () => {
    store.load("test-store");
    const p = http.expectOne("/v1/public/stores/test-store");
    expect(p.request.credentials).toBe("omit");
    expect(p.request.headers.has("Authorization")).toBe(false);
    p.flush(profile());
    const s = http.expectOne("/v1/public/stores/test-store/status");
    expect(s.request.cache).toBe("no-store");
    s.flush(status);
    expect(store.availability()).toBe("open");
    expect(store.name()).toBe("test-store");
  });
  it("cancels old requests and clears identity before another tenant loads", () => {
    store.load("test-store");
    const p = http.expectOne("/v1/public/stores/test-store");
    const s = http.expectOne("/v1/public/stores/test-store/status");
    store.load("next-store");
    expect(p.cancelled).toBe(true);
    expect(s.cancelled).toBe(true);
    expect(store.profile()).toBeNull();
    http.expectOne("/v1/public/stores/next-store").flush(profile("next-store"));
    http.expectOne("/v1/public/stores/next-store/status").flush(status);
    expect(store.name()).toBe("next-store");
  });
  it("rejects a profile from another store", () => {
    store.load("test-store");
    http
      .expectOne("/v1/public/stores/test-store")
      .flush(profile("other-store"));
    http.expectOne("/v1/public/stores/test-store/status").flush(status);
    expect(store.profile()).toBeNull();
    expect(store.brandFailed()).toBe(true);
  });
  it("unavailable wins over an otherwise open response", () => {
    store.load("test-store");
    http
      .expectOne("/v1/public/stores/test-store")
      .flush({}, { status: 404, statusText: "Not Found" });
    http.expectOne("/v1/public/stores/test-store/status").flush(status);
    expect(store.availability()).toBe("unavailable");
    expect(store.profile()).toBeNull();
  });
  it("a status error never presents the store as open; retry recovers", () => {
    store.load("test-store");
    http.expectOne("/v1/public/stores/test-store").flush(profile());
    http
      .expectOne("/v1/public/stores/test-store/status")
      .flush({}, { status: 503, statusText: "Unavailable" });
    expect(store.availability()).toBe("offline");
    store.refresh();
    http.expectOne("/v1/public/stores/test-store").flush(profile());
    http
      .expectOne("/v1/public/stores/test-store/status")
      .flush({ ...status, open: false, reason: "PAUSED" });
    expect(store.availability()).toBe("closed");
  });
  it("invalid slug performs no HTTP request", () => {
    store.load("../admin");
    http.expectNone(() => true);
    expect(store.availability()).toBe("unavailable");
  });
  it("malformed or contradictory status is not trusted", () => {
    expect(readAvailability({ ...status, open: "true" })).toBeNull();
    expect(readAvailability({ ...status, reason: "PAUSED" })).toBeNull();
    expect(readAvailability(null)).toBeNull();
  });
  it("rejects unsafe theme colors", () => {
    store.load("test-store");
    const p = profile();
    p.brand.colors = { ...DEFAULT_BRAND_COLORS, onPrimary: "#FFFFFF" };
    http.expectOne("/v1/public/stores/test-store").flush(p);
    http.expectOne("/v1/public/stores/test-store/status").flush(status);
    expect(store.profile()).toBeNull();
  });
});
