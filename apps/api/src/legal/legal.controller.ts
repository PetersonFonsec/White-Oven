import {
  type ArgumentsHost,
  Catch,
  Controller,
  type ExceptionFilter,
  Get,
  Header,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
  UseFilters,
} from "@nestjs/common";
import { ApiExcludeController, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import type { StoreLegalDocuments } from "@whiteoven/contracts";
import { PASSWORD_MAX_LENGTH } from "../auth/password";
import { CustomerAuth } from "../customer/customer-auth.service";
import { normalizeEmail } from "../customer/customer-rules";
import { ApiError } from "../errors/api-error";
import { clientIpOf } from "../security/http-security";
import { JsonLogger } from "../logging/json-logger";
import { requestIdOf } from "../logging/request-context";
import { describeError } from "../logging/sanitize";
import { STORE_SLUG_PARAM, StoreTenant } from "../tenancy/store-tenant.guard";
import { LegalDocuments } from "./legal-documents.service";
import {
  type DeletionOutcome,
  LEGAL_PAGE_CSP,
  deletionPage,
  documentPage,
  errorPage,
} from "./legal-pages";

/** Web pages live outside `/v1` (app.ts): their URLs go in the app store listings. */
export const LEGAL_PAGES_PREFIX = "lojas";

@ApiTags("public")
@Controller("public/stores/:storeSlug/legal")
export class PublicLegalController {
  constructor(private readonly legal: LegalDocuments) {}

  @Get()
  @StoreTenant("legalRead")
  // Revalidate on every use: a new version must reach the sign-up screen at once.
  @Header("Cache-Control", "no-cache")
  @ApiOperation({
    summary: "The store's current privacy policy and terms of use (ADR 0030)",
    description:
      "Either document is null until the store publishes it; sign-up needs both.",
  })
  async get(): Promise<StoreLegalDocuments> {
    const { privacyPolicy, termsOfUse } = await this.legal.current();
    return { privacyPolicy, termsOfUse };
  }
}

const pageHeaders = (res: Response, cache: string) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Content-Security-Policy", LEGAL_PAGE_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", cache);
};

/** Errors on the web pages are HTML for people, never the JSON body. */
@Catch()
export class LegalPageExceptionFilter implements ExceptionFilter {
  constructor(@Inject(JsonLogger) private readonly logger: JsonLogger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const status =
      exception instanceof HttpException && exception.getStatus() < 500
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;
    if (status === HttpStatus.INTERNAL_SERVER_ERROR)
      // Only the error class and stack frames, as in ApiExceptionFilter.
      this.logger.write("error", "unhandled exception", {
        requestId: requestIdOf(http.getRequest<Request>()),
        ...describeError(exception),
      });
    if (res.headersSent) return;
    pageHeaders(res, "no-store");
    res.status(status).send(errorPage(status));
  }
}

/**
 * The fields of the deletion form. `app.ts` limits URL-encoded bodies to 4 KiB, flat (Express
 * would otherwise accept 100 KiB of nested objects on every route); anything that is not a form
 * of strings counts as an incomplete form.
 */
function formOf(req: Request): Record<string, string> | null {
  const type = (req.headers["content-type"] ?? "").split(";")[0]!.trim();
  const body = req.body as unknown;
  if (
    type.toLowerCase() !== "application/x-www-form-urlencoded" ||
    typeof body !== "object" ||
    body === null ||
    Object.values(body).some((value) => typeof value !== "string")
  )
    return null;
  return body as Record<string, string>;
}

const slugOf = (req: Request) => req.params[STORE_SLUG_PARAM] as string;

/**
 * Public web pages of a store (ADR 0030): its privacy policy and terms, which the App Store and
 * Google Play listings link to, and the account deletion request Google Play requires outside
 * the app. They stay available whatever the store's status, except deleting, which follows the
 * customer account rules (ACTIVE, SUSPENDED or CLOSED).
 */
@ApiExcludeController()
@Controller(`${LEGAL_PAGES_PREFIX}/:storeSlug`)
@UseFilters(LegalPageExceptionFilter)
export class LegalPagesController {
  constructor(
    private readonly legal: LegalDocuments,
    private readonly auth: CustomerAuth,
  ) {}

  @Get("privacidade")
  @StoreTenant("legalRead")
  async privacy(@Req() req: Request, @Res() res: Response): Promise<void> {
    const current = await this.legal.current();
    pageHeaders(res, "no-cache");
    res.status(current.privacyPolicy ? HttpStatus.OK : HttpStatus.NOT_FOUND);
    res.send(
      documentPage({
        storeName: current.storeName,
        slug: slugOf(req),
        page: "privacidade",
        document: current.privacyPolicy,
      }),
    );
  }

  @Get("termos")
  @StoreTenant("legalRead")
  async terms(@Req() req: Request, @Res() res: Response): Promise<void> {
    const current = await this.legal.current();
    pageHeaders(res, "no-cache");
    res.status(current.termsOfUse ? HttpStatus.OK : HttpStatus.NOT_FOUND);
    res.send(
      documentPage({
        storeName: current.storeName,
        slug: slugOf(req),
        page: "termos",
        document: current.termsOfUse,
      }),
    );
  }

  @Get("excluir-conta")
  @StoreTenant("legalRead")
  async deletionForm(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.renderDeletion(req, res, "form", HttpStatus.OK);
  }

  @Post("excluir-conta")
  @StoreTenant("customerAccount")
  async deleteAccount(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const form = formOf(req);
    const email = normalizeEmail(form?.["email"] ?? "");
    const password = form?.["password"] ?? "";
    if (!form || !email || !password || form["confirm"] !== "yes")
      return this.renderDeletion(
        req,
        res,
        "incomplete",
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    const ip = clientIpOf(req);
    const wait = this.auth.loginRetryAfterSeconds(email, ip);
    if (wait > 0) {
      res.setHeader("Retry-After", String(wait));
      return this.renderDeletion(
        req,
        res,
        "rate-limited",
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    try {
      await this.auth.deleteAccountWithCredentials(
        email,
        // Oversized passwords fail like wrong ones, without being hashed.
        password.length <= PASSWORD_MAX_LENGTH * 4 ? password : "",
        ip,
      );
    } catch (error) {
      if (error instanceof ApiError && error.code === "INVALID_CREDENTIALS")
        return this.renderDeletion(
          req,
          res,
          "invalid",
          HttpStatus.UNAUTHORIZED,
        );
      throw error;
    }
    return this.renderDeletion(req, res, "deleted", HttpStatus.OK);
  }

  private async renderDeletion(
    req: Request,
    res: Response,
    outcome: DeletionOutcome,
    status: number,
  ): Promise<void> {
    const { storeName } = await this.legal.current();
    pageHeaders(res, "no-store");
    res
      .status(status)
      .send(deletionPage({ storeName, slug: slugOf(req), outcome }));
  }
}
