import { HttpClient, type HttpInterceptorFn } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";
import { timeout } from "rxjs";
export const validSlug = (slug: string): boolean =>
  /^[a-z0-9-]{3,40}$/.test(slug);
export function storePath(slug: string): string {
  if (!validSlug(slug)) throw new Error("Invalid store slug");
  return `/v1/public/stores/${encodeURIComponent(slug)}`;
}
/** Public reads never inherit a staff cookie or an authorization header. */
export const publicApiInterceptor: HttpInterceptorFn = (req, next) =>
  next(
    req.url.startsWith("/v1/public/stores/")
      ? req.clone({
          withCredentials: false,
          credentials: "omit",
          headers: req.headers
            .delete("Authorization")
            .set("Accept", "application/json"),
        })
      : req,
  );
@Injectable({ providedIn: "root" })
export class PublicApi {
  private readonly http = inject(HttpClient);
  profile(slug: string) {
    return this.http.get<unknown>(storePath(slug)).pipe(timeout(8000));
  }
  status(slug: string) {
    return this.http
      .get<unknown>(`${storePath(slug)}/status`, { cache: "no-store" })
      .pipe(timeout(8000));
  }
}
