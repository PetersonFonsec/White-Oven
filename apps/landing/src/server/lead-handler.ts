import {
  validateLeadSubmission,
  CONSENT_VERSION,
  type LeadResponse,
} from "@whiteoven/contracts";
import type { CaptureConfig } from "./config.ts";
import { IdempotencyConflict, type LeadRepository } from "./lead-store.ts";

// A process-wide budget also works behind proxies without trusting spoofable IP headers.
// No IP address, hash or fingerprint is retained. One Node process is the deployment boundary.
export class SubmissionLimiter {
  private started = 0;
  private count = 0;
  private readonly maximum: number;
  private readonly windowMs: number;
  constructor(maximum = 60, windowMs = 600_000) {
    this.maximum = maximum;
    this.windowMs = windowMs;
  }
  allow(now: number): boolean {
    if (now - this.started >= this.windowMs) {
      this.started = now;
      this.count = 0;
    }
    return ++this.count <= this.maximum;
  }
}
const json = (
  body: LeadResponse | { available: boolean; consentVersion: string },
  status = 200,
) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(status === 429 ? { "Retry-After": "600" } : {}),
    },
  });
const failure = (
  status: number,
  code: Extract<LeadResponse, { ok: false }>["code"],
  message: string,
) => json({ ok: false, code, message }, status);
export function createLeadHandler(
  config: () => CaptureConfig,
  repository: () => LeadRepository,
  limiter = new SubmissionLimiter(),
  clock = Date.now,
) {
  return async (request: Request): Promise<Response> => {
    const settings = config();
    if (request.method === "GET")
      return json({
        available: settings.enabled,
        consentVersion: CONSENT_VERSION,
      });
    if (request.method !== "POST")
      return failure(405, "INVALID_REQUEST", "Método não permitido.");
    if (!settings.enabled)
      return failure(
        503,
        "UNAVAILABLE",
        "As inscrições estão temporariamente indisponíveis. Tente novamente mais tarde.",
      );
    if (request.headers.get("origin") !== settings.origin)
      return failure(403, "INVALID_REQUEST", "Origem não permitida.");
    if (!limiter.allow(clock()))
      return failure(
        429,
        "RATE_LIMITED",
        "Muitas tentativas. Aguarde dez minutos e tente novamente.",
      );
    if (
      request.headers.get("content-type")?.split(";")[0].trim() !==
      "application/json"
    )
      return failure(415, "INVALID_REQUEST", "Formato de envio inválido.");
    const key = request.headers.get("idempotency-key") ?? "";
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        key,
      )
    )
      return failure(
        400,
        "INVALID_REQUEST",
        "Identificador de envio inválido.",
      );
    const MAX_BYTES = 8192;
    if (Number(request.headers.get("content-length")) > MAX_BYTES)
      return failure(
        413,
        "INVALID_REQUEST",
        "Envio excede o tamanho permitido.",
      );
    try {
      const reader = request.body?.getReader();
      if (!reader) return failure(400, "INVALID_REQUEST", "Envio inválido.");
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BYTES) {
          await reader.cancel();
          return failure(
            413,
            "INVALID_REQUEST",
            "Envio excede o tamanho permitido.",
          );
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        );
      } catch {
        return failure(400, "INVALID_REQUEST", "Envio inválido.");
      }
      const parsed = validateLeadSubmission(raw);
      if (!parsed.valid)
        return json(
          {
            ok: false,
            code: "VALIDATION",
            message: "Revise os dados informados e tente novamente.",
            fields: parsed.fields,
          },
          422,
        );
      const result = repository().save(
        parsed.value,
        key,
        settings.policy,
        clock(),
      );
      return json(
        { ok: true, leadId: result.lead.id, createdAt: result.lead.createdAt },
        result.created ? 201 : 200,
      );
    } catch (error) {
      if (error instanceof IdempotencyConflict)
        return failure(
          409,
          "IDEMPOTENCY_CONFLICT",
          "Os dados mudaram. Revise e envie novamente.",
        );
      // Never log bodies, database errors or personal information.
      return failure(
        503,
        "UNAVAILABLE",
        "Não foi possível salvar seu interesse. Seus campos foram mantidos; tente novamente.",
      );
    }
  };
}
