import type { LoggerService } from "@nestjs/common";
import type { LogLevel } from "../config/config";

const SEVERITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Keys that may carry personal data or secrets. Values under them are never written,
 * whatever their nesting depth. Callers should still avoid passing such fields at all.
 */
const SENSITIVE_KEY =
  /pass(word)?|secret|token|authorization|cookie|session|e-?mail|phone|whatsapp|cpf|document|address|^ip$|user-?agent|^name$|fullname|customername/i;

export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1),
      ]),
    );
  }
  return value;
}

/** One JSON object per line on stdout, for `docker compose logs` and any log shipper. */
export class JsonLogger implements LoggerService {
  constructor(
    private readonly level: LogLevel,
    private readonly sink: LogSink = (line) =>
      process.stdout.write(`${line}\n`),
  ) {}

  write(level: LogLevel, msg: string, fields: LogFields = {}): void {
    if (SEVERITY[level] < SEVERITY[this.level]) return;
    const entry = {
      time: new Date().toISOString(),
      level,
      msg,
      ...(redact(fields) as LogFields),
    };
    this.sink(JSON.stringify(entry));
  }

  // LoggerService adapter: Nest passes an optional trailing context string.
  log(message: unknown, ...params: unknown[]): void {
    this.write("info", String(message), contextOf(params));
  }
  error(message: unknown, ...params: unknown[]): void {
    // Nest passes (message, stack?, context?). Stacks of framework errors carry no request data.
    const context = params.length > 0 ? params[params.length - 1] : undefined;
    this.write(
      "error",
      String(message),
      typeof context === "string" ? { context } : {},
    );
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.write("warn", String(message), contextOf(params));
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.write("debug", String(message), contextOf(params));
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.write("debug", String(message), contextOf(params));
  }
}

const contextOf = (params: unknown[]): LogFields => {
  const context = params[params.length - 1];
  return typeof context === "string" ? { context } : {};
};
