import { type DynamicModule, Module } from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { API_CONFIG, type ApiConfig } from "./config/config";
import { DatabaseModule } from "./database/database.module";
import { HealthController } from "./health/health.controller";
import { TenancyModule } from "./tenancy/tenancy.module";

@Module({})
export class AppModule {
  static forRoot(config: ApiConfig, orm: MikroORM): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [DatabaseModule.forRoot(orm), TenancyModule],
      controllers: [HealthController],
      providers: [{ provide: API_CONFIG, useValue: config }],
      exports: [API_CONFIG],
    };
  }
}
