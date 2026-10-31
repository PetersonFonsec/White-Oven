import { type DynamicModule, Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import type { MikroORM } from "@mikro-orm/postgresql";
import { AuthModule } from "./auth/auth.module";
import { RouteAccessGuard } from "./auth/route-access";
import { API_CONFIG, type ApiConfig } from "./config/config";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { JsonLogger } from "./logging/json-logger";
import { TenancyModule } from "./tenancy/tenancy.module";
import { PlatformModule } from "./platform/platform.module";
import { CatalogModule } from "./catalog/catalog.module";
import { ImageModule } from "./images/image.module";
import { StoreModule } from "./store/store.module";
import { TeamModule } from "./team/team.module";
import { CustomerModule } from "./customer/customer.module";
import { OrderModule } from "./order/order.module";
import { PushModule } from "./push/push.module";
import { LegalModule } from "./legal/legal.module";
import { RequestLimits } from "./security/request-limits";

@Module({})
export class AppModule {
  static forRoot(
    config: ApiConfig,
    orm: MikroORM,
    logger: JsonLogger,
    limits: RequestLimits = new RequestLimits(),
  ): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        DatabaseModule.forRoot(orm),
        TenancyModule,
        AuthModule,
        PlatformModule,
        CatalogModule,
        ImageModule,
        StoreModule,
        TeamModule,
        CustomerModule,
        OrderModule,
        PushModule,
        LegalModule,
      ],
      controllers: [HealthController],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: JsonLogger, useValue: logger },
        { provide: RequestLimits, useValue: limits },
        // Runs before every route guard: undeclared routes are refused.
        { provide: APP_GUARD, useClass: RouteAccessGuard },
      ],
      exports: [API_CONFIG, JsonLogger, RequestLimits],
    };
  }
}
