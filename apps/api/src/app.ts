import "reflect-metadata";
import type { INestApplication, Type } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from "@nestjs/swagger";
import { AppModule } from "./app.module";
import type { ApiConfig } from "./config/config";
import { createOrm } from "./database/orm";
import { ApiErrorBody } from "./errors/api-error";
import { ApiExceptionFilter } from "./errors/api-exception.filter";
import { JsonLogger } from "./logging/json-logger";
import { requestContext } from "./logging/request-context";

export const API_PREFIX = "v1";
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json`;

export interface CreateAppOptions {
  logger?: JsonLogger;
  /** Extra modules, used by tests to mount probe routes. */
  imports?: Type[];
}

export async function createApp(
  config: ApiConfig,
  options: CreateAppOptions = {},
): Promise<NestExpressApplication> {
  const logger = options.logger ?? new JsonLogger(config.logLevel);
  // Lazy pool: building the app never touches the database; main.ts verifies the role.
  const orm = await createOrm(config.database);
  const appModule = AppModule.forRoot(config, orm);
  const root = options.imports?.length
    ? {
        module: class RootModule {},
        imports: [appModule, ...options.imports],
      }
    : appModule;

  const app = await NestFactory.create<NestExpressApplication>(root, {
    logger,
    bufferLogs: false,
    abortOnError: false,
  });
  app.disable("x-powered-by");
  app.useBodyParser("json", { limit: "100kb" });
  app.use(requestContext(logger));
  app.setGlobalPrefix(API_PREFIX, { exclude: ["health", "health/ready"] });
  app.useGlobalFilters(new ApiExceptionFilter(logger));
  app.enableShutdownHooks();

  if (config.openApiEnabled) {
    SwaggerModule.setup(
      `${API_PREFIX}/docs`,
      app,
      () => buildOpenApiDocument(app),
      {
        ui: false,
        raw: ["json"],
        jsonDocumentUrl: OPENAPI_PATH,
      },
    );
  }
  return app;
}

export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const document = new DocumentBuilder()
    .setTitle("WhiteOven API")
    .setVersion("1")
    .setDescription("REST JSON API. Errors use the ApiErrorBody schema.")
    .build();
  return SwaggerModule.createDocument(app, document, {
    extraModels: [ApiErrorBody],
  });
}
