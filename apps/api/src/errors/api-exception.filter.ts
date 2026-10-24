import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { JsonLogger } from "../logging/json-logger";
import { requestIdOf } from "../logging/request-context";
import { ApiError, type ApiErrorBody } from "./api-error";

const CODE_BY_STATUS: Partial<Record<number, string>> = {
  [HttpStatus.BAD_REQUEST]: "BAD_REQUEST",
  [HttpStatus.UNAUTHORIZED]: "UNAUTHORIZED",
  [HttpStatus.FORBIDDEN]: "FORBIDDEN",
  [HttpStatus.NOT_FOUND]: "NOT_FOUND",
  [HttpStatus.METHOD_NOT_ALLOWED]: "METHOD_NOT_ALLOWED",
  [HttpStatus.CONFLICT]: "CONFLICT",
  [HttpStatus.PAYLOAD_TOO_LARGE]: "PAYLOAD_TOO_LARGE",
  [HttpStatus.UNSUPPORTED_MEDIA_TYPE]: "UNSUPPORTED_MEDIA_TYPE",
  [HttpStatus.UNPROCESSABLE_ENTITY]: "VALIDATION_FAILED",
  [HttpStatus.TOO_MANY_REQUESTS]: "RATE_LIMITED",
  [HttpStatus.SERVICE_UNAVAILABLE]: "SERVICE_UNAVAILABLE",
};

const MESSAGE_BY_CODE: Record<string, string> = {
  NOT_FOUND: "Resource not found.",
  INTERNAL_ERROR: "Unexpected error. Try again later.",
};

/** Turns every thrown value into the standard error body; unknown errors become a bare 500. */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const requestId = requestIdOf(req);

    let status: number;
    let body: ApiErrorBody;

    if (exception instanceof ApiError) {
      status = exception.getStatus();
      body = { code: exception.code, message: exception.message, requestId };
      if (exception.details) body.details = exception.details;
    } else if (
      exception instanceof HttpException &&
      exception.getStatus() < 500
    ) {
      status = exception.getStatus();
      const code = CODE_BY_STATUS[status] ?? "HTTP_ERROR";
      // Framework messages can echo the request path ("Cannot GET /x"); use fixed text instead.
      body = {
        code,
        message: MESSAGE_BY_CODE[code] ?? "Request could not be processed.",
        requestId,
      };
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      body = {
        code: "INTERNAL_ERROR",
        message: MESSAGE_BY_CODE.INTERNAL_ERROR!,
        requestId,
      };
      // Only the error class and stack frames: messages may include values (SQL, input).
      const frames =
        exception instanceof Error
          ? exception.stack?.split("\n").slice(1, 11)
          : undefined;
      this.logger.write("error", "unhandled exception", {
        requestId,
        errorType:
          exception instanceof Error
            ? exception.constructor.name
            : typeof exception,
        frames: frames?.map((line) => line.trim()),
      });
    }

    if (res.headersSent) return;
    res.status(status).json(body);
  }
}
