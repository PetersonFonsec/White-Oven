import {
  HttpErrorResponse,
  type HttpInterceptorFn,
  type HttpRequest,
} from "@angular/common/http";
import { inject } from "@angular/core";
import { Router } from "@angular/router";
import { catchError, from, switchMap, throwError } from "rxjs";
import { API, CREDENTIAL_ROUTES, apiErrorCode } from "./api";
import { type Credentials, Session } from "./session";

const sameSession = (a: Credentials, b: Credentials) =>
  a.lineage === b.lineage && a.tenantId === b.tenantId;

/**
 * Adds the in-memory access token to API calls. An expired token (401 `UNAUTHORIZED`) is renewed
 * once through the refresh cookie and the call is retried; if the session is gone, the person
 * goes back to the sign-in page.
 *
 * A call is retried only with a token of the same session and store it was sent with: never after
 * a logout, and never with the token of another store or of a newer sign-in, whose results the
 * caller did not ask for. Requests that already carry an `Authorization` header (the session
 * loading a token's permissions before publishing it) pass through untouched.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (
    !req.url.startsWith(`${API}/`) ||
    CREDENTIAL_ROUTES.includes(req.url) ||
    req.headers.has("authorization")
  )
    return next(req);
  const session = inject(Session);
  const router = inject(Router);
  const withToken = (token: string): HttpRequest<unknown> =>
    req.clone({ setHeaders: { authorization: `Bearer ${token}` } });
  const sent = session.credentials();
  if (!sent) return next(req);
  return next(withToken(sent.token)).pipe(
    catchError((error: unknown) => {
      if (
        !(error instanceof HttpErrorResponse) ||
        error.status !== 401 ||
        apiErrorCode(error) !== "UNAUTHORIZED"
      )
        return throwError(() => error);
      const current = session.credentials();
      if (current?.token !== sent.token)
        // Another call already renewed the token, or the session changed meanwhile.
        return current && sameSession(current, sent)
          ? next(withToken(current.token))
          : throwError(() => error);
      return from(session.refresh()).pipe(
        switchMap((result) => {
          if (
            result.status === "renewed" &&
            sameSession(result.credentials, sent)
          )
            return next(withToken(result.credentials.token));
          if (result.status === "signed-out")
            void router.navigateByUrl("/entrar");
          return throwError(() => error);
        }),
      );
    }),
  );
};
