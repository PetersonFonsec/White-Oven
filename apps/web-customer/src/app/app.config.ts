import {
  BaseRouteReuseStrategy,
  RouteReuseStrategy,
  type ActivatedRouteSnapshot,
} from "@angular/router";
import { type ApplicationConfig } from "@angular/core";
import { provideHttpClient, withInterceptors } from "@angular/common/http";
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
} from "@angular/router";
import { routes } from "./app.routes";
import { publicApiInterceptor } from "./core/api/public-api";
class StoreRouteReuse extends BaseRouteReuseStrategy {
  override shouldReuseRoute(
    next: ActivatedRouteSnapshot,
    current: ActivatedRouteSnapshot,
  ): boolean {
    return (
      super.shouldReuseRoute(next, current) &&
      next.paramMap.get("storeSlug") === current.paramMap.get("storeSlug")
    );
  }
}
export const appConfig: ApplicationConfig = {
  providers: [
    { provide: RouteReuseStrategy, useClass: StoreRouteReuse },
    provideHttpClient(withInterceptors([publicApiInterceptor])),
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: "enabled" }),
    ),
  ],
};
