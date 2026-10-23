import {
  validateLeadSubmission,
  CONSENT_VERSION,
  type LeadResponse,
} from "@whiteoven/contracts";
import type { CaptureConfig } from "./config.ts";
import { IdempotencyConflict, type LeadRepository } from "./lead-store.ts";

import { createHmac, randomBytes } from "node:crypto";

export class SubmissionLimiter {
  private started = 0;
  private count = 0;
  private readonly secret = randomBytes(32);
  private readonly clients = new Map<
    string,
    { started: number; count: number }
  >();
  private readonly active = new Map<string, number>();
  private inFlight = 0;
  private readonly maximum: number;
  private readonly windowMs: number;
  private readonly perClient: number;
  private readonly maxClients: number;
  constructor(
    maximum = 600,
    windowMs = 600_000,
    perClient = 10,
    maxClients = 4096,
  ) {
    this.maximum = maximum;
    this.windowMs = windowMs;
    this.perClient = perClient;
    this.maxClients = maxClients;
  }
  private identity(client: string) {
    return createHmac("sha256", this.secret).update(client).digest("hex");
  }
  allow(now: number, client = "development"): boolean {
    for (const [key, value] of this.clients)
      if (now - value.started >= this.windowMs) this.clients.delete(key);
    const key = this.identity(client);
    let bucket = this.clients.get(key);
    if (!bucket) {
      if (this.clients.size >= this.maxClients) return false;
      bucket = { started: now, count: 0 };
      this.clients.set(key, bucket);
      const retained = bucket;
      setTimeout(() => {
        if (this.clients.get(key) === retained) this.clients.delete(key);
      }, this.windowMs).unref();
    }
    // Rejected clients cannot consume the global emergency budget.
    if (bucket.count >= this.perClient) return false;
    bucket.count++;
    if (now - this.started >= this.windowMs) {
      this.started = now;
      this.count = 0;
    }
    return ++this.count <= this.maximum;
  }
  acquire(client: string): (() => void) | null {
    const key = this.identity(client);
    const count = this.active.get(key) ?? 0;
    if (this.inFlight >= 16 || count >= 2) return null;
    this.inFlight++;
    this.active.set(key, count + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight--;
      const remaining = this.active.get(key)! - 1;
      if (remaining) this.active.set(key, remaining);
      else this.active.delete(key);
    };
  }
}
class BodyTimeout extends Error {}
const cancelReader = (reader: ReadableStreamDefaultReader<Uint8Array>) => {
  // A malicious underlying cancel() can itself never settle; never await it.
  void reader.cancel().catch(() => {});
};
async function readBody(
  request: Request,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new BodyTimeout());
      cancelReader(reader);
    }, timeoutMs);
  });
  try {
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      length += value.byteLength;
      if (length > 8192) {
        cancelReader(reader);
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
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
  bodyTimeoutMs = 5000,
) {
  return async (
    request: Request,
    client = "development",
  ): Promise<Response> => {
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
    if (!limiter.allow(clock(), client))
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
    const release = limiter.acquire(client);
    if (!release)
      return failure(
        429,
        "RATE_LIMITED",
        "Muitas tentativas. Aguarde dez minutos e tente novamente.",
      );
    try {
      const bytes = await readBody(request, bodyTimeoutMs);
      if (!bytes)
        return failure(
          413,
          "INVALID_REQUEST",
          "Envio excede o tamanho permitido.",
        );
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
      if (error instanceof BodyTimeout)
        return failure(
          408,
          "INVALID_REQUEST",
          "O envio demorou demais. Tente novamente.",
        );
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
    } finally {
      release();
    }
  };
}
