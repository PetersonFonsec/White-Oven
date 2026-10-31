import "reflect-metadata";
import {
  type INestApplication,
  RequestMethod,
  type Type,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { EntitySchema } from "@mikro-orm/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from "@nestjs/swagger";
import { AppModule } from "./app.module";
import type { ApiConfig } from "./config/config";
import { ENTITIES, createOrm } from "./database/orm";
import { ApiErrorBody } from "./errors/api-error";
import { ApiExceptionFilter } from "./errors/api-exception.filter";
import { JsonLogger } from "./logging/json-logger";
import { requestContext } from "./logging/request-context";
import { LEGAL_PAGES_PREFIX } from "./legal/legal.controller";

export const API_PREFIX = "v1";
export const OPENAPI_PATH = `${API_PREFIX}/openapi.json`;

export interface CreateAppOptions {
  logger?: JsonLogger;
  /** Extra modules, used by tests to mount probe routes. */
  imports?: Type[];
  /** Extra entities for those probe routes; checked by `assertTenantFilters` like any other. */
  entities?: EntitySchema[];
}

export async function createApp(
  config: ApiConfig,
  options: CreateAppOptions = {},
): Promise<NestExpressApplication> {
  const logger = options.logger ?? new JsonLogger(config.logLevel);
  // Lazy pool: building the app never touches the database; main.ts verifies the role.
  const orm = await createOrm(
    config.database,
    options.entities?.length
      ? { entities: [...ENTITIES, ...options.entities] }
      : {},
  );
  const appModule = AppModule.forRoot(config, orm, logger);
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
  // Only the account deletion page posts a form (ADR 0030): small and flat. Registering it here
  // replaces Express's default (100 KiB, nested objects) for every route.
  app.useBodyParser("urlencoded", {
    limit: "4kb",
    extended: false,
    parameterLimit: 10,
  });
  app.use(requestContext(logger));
  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      "health",
      "health/ready",
      // The store's legal pages (ADR 0030): URLs for people and app store listings.
      { path: `${LEGAL_PAGES_PREFIX}/*path`, method: RequestMethod.ALL },
    ],
  });
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
