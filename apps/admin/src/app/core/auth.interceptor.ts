import {
  HttpErrorResponse,
  type HttpInterceptorFn,
  type HttpRequest,
} from "@angular/common/http";
import { inject } from "@angular/core";
import { Router } from "@angular/router";
import { catchError, from, switchMap, throwError } from "rxjs";
import { API, CREDENTIAL_ROUTES, apiErrorCode } from "./api";
import { Session } from "./session";

/**
 * Adds the in-memory access token to API calls. An expired token (401 `UNAUTHORIZED`) is renewed
 * once through the refresh cookie and the call is retried; if the session is gone, the person
 * goes back to the sign-in page.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  if (!req.url.startsWith(`${API}/`) || CREDENTIAL_ROUTES.includes(req.url))
    return next(req);
  const session = inject(Session);
  const router = inject(Router);
  const withToken = (token: string | null): HttpRequest<unknown> =>
    token
      ? req.clone({ setHeaders: { authorization: `Bearer ${token}` } })
      : req;
  return next(withToken(session.accessToken())).pipe(
    catchError((error: unknown) => {
      if (
        !(error instanceof HttpErrorResponse) ||
        error.status !== 401 ||
        apiErrorCode(error) !== "UNAUTHORIZED"
      )
        return throwError(() => error);
      return from(session.refresh()).pipe(
        switchMap((token) => {
          if (!token) {
            void router.navigateByUrl("/entrar");
            return throwError(() => error);
          }
          return next(withToken(token));
        }),
      );
    }),
  );
};
