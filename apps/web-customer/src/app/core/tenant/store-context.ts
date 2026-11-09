import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  signal,
} from "@angular/core";
import { HttpErrorResponse } from "@angular/common/http";
import { catchError, forkJoin, map, of, type Subscription } from "rxjs";
import { parseProfile, type PublicStoreProfile } from "@whiteoven/contracts";
import {
  parseCheckoutSettings,
  type CheckoutSettings,
} from "@whiteoven/customer-core/cart/summary";
import { PublicApi, storePath, validSlug } from "../api/public-api";

type Availability = "loading" | "open" | "closed" | "offline" | "unavailable";
type Answer =
  { kind: "ok"; body: unknown } | { kind: "unavailable" | "failed" };
function failure(error: unknown): Answer {
  return {
    kind:
      error instanceof HttpErrorResponse && [403, 404].includes(error.status)
        ? "unavailable"
        : "failed",
  };
}
export function readAvailability(body: unknown): "open" | "closed" | null {
  if (!body || typeof body !== "object") return null;
  const s = body as Record<string, unknown>;
  if (
    typeof s.timezone !== "string" ||
    !s.timezone ||
    (s.pausedUntil !== null &&
      (typeof s.pausedUntil !== "string" ||
        !Number.isFinite(Date.parse(s.pausedUntil))))
  )
    return null;
  if (s.open === true && s.reason === "OPEN") return "open";
  if (
    s.open === false &&
    ["PAUSED", "OUTSIDE_HOURS", "TENANT_NOT_ACTIVE"].includes(String(s.reason))
  )
    return "closed";
  return null;
}
/** Scoped to the store shell, canceled on navigation; no persistent customer or brand data. */
@Injectable()
export class StoreContext {
  private readonly api = inject(PublicApi);
  private active?: Subscription;
  readonly slug = signal("");
  readonly profile = signal<PublicStoreProfile | null>(null);
  readonly availability = signal<Availability>("loading");
  readonly checkout = signal<CheckoutSettings | null>(null);
  readonly brandFailed = signal(false);
  readonly name = computed(() => this.profile()?.name ?? "Sua pizzaria");
  readonly logo = computed(() => {
    const id = this.profile()?.brand.logoImageId;
    return id ? `${storePath(this.slug())}/images/${id}/thumbnail` : null;
  });
  constructor() {
    inject(DestroyRef).onDestroy(() => this.active?.unsubscribe());
  }
  load(slug: string): void {
    this.active?.unsubscribe();
    this.slug.set(slug);
    this.profile.set(null);
    this.checkout.set(null);
    this.brandFailed.set(false);
    this.availability.set("loading");
    if (!validSlug(slug)) {
      this.availability.set("unavailable");
      return;
    }
    const answer = map((body: unknown): Answer => ({ kind: "ok", body }));
    this.active = forkJoin({
      profile: this.api.profile(slug).pipe(
        answer,
        catchError((e) => of(failure(e))),
      ),
      status: this.api.status(slug).pipe(
        answer,
        catchError((e) => of(failure(e))),
      ),
    }).subscribe(({ profile, status }) => {
      if (profile.kind === "unavailable" || status.kind === "unavailable") {
        this.availability.set("unavailable");
        return;
      }
      const parsed =
        profile.kind === "ok" ? parseProfile(profile.body, slug) : null;
      this.profile.set(parsed);
      if (parsed && profile.kind === "ok")
        this.checkout.set(
          parseCheckoutSettings(
            (profile.body as { checkout?: unknown }).checkout,
          ),
        );
      this.brandFailed.set(!parsed);
      this.availability.set(
        status.kind === "ok"
          ? (readAvailability(status.body) ?? "offline")
          : "offline",
      );
    });
  }
  refresh(): void {
    this.load(this.slug());
  }
}
