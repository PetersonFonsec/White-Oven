import { HttpException, HttpStatus } from "@nestjs/common";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Standard error body for every non-2xx response. `code` is stable and machine-readable;
 * `message` is safe to show; `details` is optional structured data (e.g. field errors).
 * Never contains stacks, SQL, configuration or personal data.
 */
export class ApiErrorBody {
  @ApiProperty({ example: "NOT_FOUND" })
  code!: string;

  @ApiProperty({ example: "Resource not found." })
  message!: string;

  @ApiPropertyOptional({ type: "object", additionalProperties: true })
  details?: Record<string, unknown>;

  @ApiProperty({ example: "0b6f4f5e-3c1e-4d55-9a8b-6a0b0f1c2d3e" })
  requestId!: string;
}

/** Domain-level error with an explicit code. Prefer it over bare HttpException. */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message, status);
  }
}
