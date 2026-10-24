import { type DynamicModule, Module } from "@nestjs/common";
import { API_CONFIG, type ApiConfig } from "./config/config";
import { HealthController } from "./health/health.controller";

@Module({})
export class AppModule {
  static forRoot(config: ApiConfig): DynamicModule {
    return {
      module: AppModule,
      global: true,
      controllers: [HealthController],
      providers: [{ provide: API_CONFIG, useValue: config }],
      exports: [API_CONFIG],
    };
  }
}
