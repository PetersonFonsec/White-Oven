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

@Module({})
export class AppModule {
  static forRoot(
    config: ApiConfig,
    orm: MikroORM,
    logger: JsonLogger,
  ): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule.forRoot(orm), TenancyModule, AuthModule],
      controllers: [HealthController],
      providers: [
        { provide: API_CONFIG, useValue: config },
        { provide: JsonLogger, useValue: logger },
        // Runs before every route guard: undeclared routes are refused.
        { provide: APP_GUARD, useClass: RouteAccessGuard },
      ],
      exports: [API_CONFIG, JsonLogger],
    };
  }
}
