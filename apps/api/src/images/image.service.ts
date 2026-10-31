import { randomUUID } from "node:crypto";
import { HttpStatus, Inject, Injectable } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import { TenantTransactions } from "../tenancy/tenant-transaction";
import { currentTenantContext } from "../tenancy/tenant-context";
import {
  TenantStatusPolicy,
  type TenantCapability,
} from "../tenancy/tenant-status-policy";
import type { TenantStatus } from "../tenancy/tenant.entity";
import { ApiError } from "../errors/api-error";
import { JsonLogger } from "../logging/json-logger";
import {
  PublicMenuService,
  publicMenuImageIds,
} from "../catalog/public-menu.service";
import {
  IMAGE_PROCESSOR,
  IMAGE_STORAGE,
  type ImageStorage,
  type ImageVariant,
  type ProcessedImage,
} from "./image-storage";
import type { ImageProcessor } from "./image-storage";

const notFound = () =>
  new ApiError(HttpStatus.NOT_FOUND, "IMAGE_NOT_FOUND", "Image not found.");
const forbidden = () =>
  new ApiError(
    HttpStatus.FORBIDDEN,
    "CATALOG_WRITE_FORBIDDEN",
    "Catalog is read-only for this store status.",
  );
const missingStorage = () =>
  new ApiError(
    HttpStatus.SERVICE_UNAVAILABLE,
    "IMAGE_STORAGE_MISSING",
    "Image is temporarily unavailable.",
  );

@Injectable()
export class ImageService {
  constructor(
    private readonly transactions: TenantTransactions,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
    @Inject(IMAGE_PROCESSOR) private readonly processImage: ImageProcessor,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
    private readonly publicMenu: PublicMenuService,
  ) {}

  async upload(bytes: Buffer, contentType: string, requestId: string) {
    const context = currentTenantContext();
    if (context.actor.type !== "staff") throw forbidden();

    // Reject unauthorized requests before invoking Sharp. This short transaction ends before
    // image decoding; the same access is checked again in the persistence transaction below.
    await this.transactions.run((em) =>
      this.authorize(em, "catalogWrite", requestId),
    );

    let processed: ProcessedImage;
    try {
      processed = await this.processImage(bytes, contentType);
    } catch {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "INVALID_IMAGE",
        "Upload must be a valid PNG, JPEG, or WebP image.",
      );
    }
    const assetId = randomUUID();
    let storageWriteCompleted = false;
    try {
      await this.transactions.run(async (em) => {
        await this.authorize(em, "catalogWrite", requestId);
        await this.storage.write(context.tenantId, assetId, processed.variants);
        storageWriteCompleted = true;
        await em.execute(
          "insert into image_assets (id,tenant_id,source_format,width,height) values (?,?,?, ?, ?)",
          [
            assetId,
            context.tenantId,
            processed.sourceFormat,
            processed.width,
            processed.height,
          ],
        );
      });
    } catch (error) {
      if (storageWriteCompleted && !(await this.committedAnyway(assetId)))
        await this.compensateStorageWrite(context.tenantId, assetId, error);
      const code = (error as { code?: string } | null)?.code;
      if (code === "23503" || code === "23514")
        throw new ApiError(
          HttpStatus.CONFLICT,
          "IMAGE_STORAGE_CONFLICT",
          "Image could not be stored.",
        );
      throw error;
    }
    return {
      id: assetId,
      width: processed.width,
      height: processed.height,
      sourceFormat: processed.sourceFormat,
      variants: {
        thumbnail: `/v1/admin/catalog/images/${assetId}/thumbnail`,
        menu: `/v1/admin/catalog/images/${assetId}/menu`,
      },
    };
  }

  async read(assetId: string, variant: ImageVariant, requestId: string) {
    const context = currentTenantContext();
    if (context.actor.type !== "staff") throw notFound();
    const found = await this.transactions.run(async (em) => {
      await this.authorize(em, "storeRead", requestId);
      const [row] = await em.execute<{ id: string }[]>(
        "select id from image_assets where id=?",
        [assetId],
      );
      return row;
    });
    if (!found) throw notFound();
    return this.readStored(assetId, variant, "read");
  }

  /**
   * An image of the store's public surface (M5.2, ADR 0021): one shown by the public menu, or the
   * brand logo. Any other id answers the same 404 as an unknown one, so an upload that is not
   * published yet, the image of an archived item or another store's image never leaves the API.
   */
  async readPublic(assetId: string, variant: ImageVariant) {
    const menu = await this.publicMenu.get();
    if (!publicMenuImageIds(menu).has(assetId)) {
      const [logo] = await this.transactions.run((em) =>
        em.execute<{ id: string }[]>(
          "select logo_asset_id as id from brand_themes where logo_asset_id = ?",
          [assetId],
        ),
      );
      if (!logo) throw notFound();
    }
    return this.readStored(assetId, variant, "public_read");
  }

  private async readStored(
    assetId: string,
    variant: ImageVariant,
    operation: string,
  ) {
    const context = currentTenantContext();
    try {
      return await this.storage.read(context.tenantId, assetId, variant);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.logger.write(
        "error",
        "image metadata exists without stored variant",
        {
          event: "image_storage.variant_missing",
          operation,
          tenantId: context.tenantId,
          assetId,
          variant,
          errorType: errorType(error),
        },
      );
      throw missingStorage();
    }
  }

  /**
   * A failed COMMIT can still have committed (the connection dropped after the server committed).
   * Files are removed only when a new transaction confirms the row does not exist: removing the
   * files of a committed image would leave the catalog and every backup with a missing image
   * (ADR 0029), while an unconfirmed orphan is harmless. When the check itself fails, the files
   * stay.
   */
  private async committedAnyway(assetId: string): Promise<boolean> {
    try {
      const [row] = await this.transactions.run((em) =>
        em.execute<{ committed: number }[]>(
          "select 1 as committed from image_assets where id = ?",
          [assetId],
        ),
      );
      if (!row) return false;
    } catch (error) {
      this.logCompensationSkipped(assetId, "commit_unknown", error);
      return true;
    }
    this.logCompensationSkipped(assetId, "committed", null);
    return true;
  }

  private logCompensationSkipped(
    assetId: string,
    reason: "committed" | "commit_unknown",
    error: unknown,
  ) {
    try {
      this.logger.write("warn", "image storage compensation skipped", {
        event: "image_storage.compensation_skipped",
        operation: "upload",
        tenantId: currentTenantContext().tenantId,
        assetId,
        reason,
        ...(error ? { errorType: errorType(error) } : {}),
      });
    } catch {
      // Logging must not replace the original database or commit failure.
    }
  }

  private async compensateStorageWrite(
    tenantId: string,
    assetId: string,
    originalError: unknown,
  ) {
    try {
      await this.storage.remove(tenantId, assetId);
    } catch (cleanupError) {
      try {
        this.logger.write("error", "image storage compensation failed", {
          event: "image_storage.compensation_failed",
          operation: "upload",
          tenantId,
          assetId,
          originalErrorType: errorType(originalError),
          cleanupErrorType: errorType(cleanupError),
        });
      } catch {
        // Logging must not replace the original database or commit failure.
      }
    }
  }

  private async authorize(
    em: EntityManager,
    capability: TenantCapability,
    requestId: string,
  ) {
    const context = currentTenantContext();
    if (context.actor.type !== "staff") throw forbidden();
    await em.execute(
      "select set_config('app.catalog_actor_id', ?, true), set_config('app.catalog_session_id', ?, true), set_config('app.catalog_request_id', ?, true)",
      [
        context.actor.staffUserId,
        context.actor.sessionId,
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          requestId,
        )
          ? requestId
          : "",
      ],
    );
    // TenantTransactions.run re-locks and validates the live staff session, user and membership
    // for every transaction. This query adds the capability-specific current tenant status.
    const [tenant] = await em.execute<{ status: TenantStatus }[]>(
      "select status from tenants where id=?",
      [context.tenantId],
    );
    if (
      !tenant ||
      !TenantStatusPolicy.allows(
        tenant.status,
        context.actor.role,
        capability,
      ) ||
      (capability === "catalogWrite" &&
        !["OWNER", "MANAGER"].includes(context.actor.role))
    )
      throw forbidden();
  }
}

const isMissingFile = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

const errorType = (error: unknown) =>
  error instanceof Error ? error.constructor.name : typeof error;
