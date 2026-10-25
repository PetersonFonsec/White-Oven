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
import {
  IMAGE_STORAGE,
  type ImageStorage,
  type ImageVariant,
} from "./image-storage";
import { processImage } from "./image-storage";

const notFound = () =>
  new ApiError(HttpStatus.NOT_FOUND, "IMAGE_NOT_FOUND", "Image not found.");
const forbidden = () =>
  new ApiError(
    HttpStatus.FORBIDDEN,
    "CATALOG_WRITE_FORBIDDEN",
    "Catalog is read-only for this store status.",
  );

@Injectable()
export class ImageService {
  constructor(
    private readonly transactions: TenantTransactions,
    @Inject(IMAGE_STORAGE) private readonly storage: ImageStorage,
  ) {}

  async upload(bytes: Buffer, contentType: string, requestId: string) {
    let processed;
    try {
      processed = await processImage(bytes, contentType);
    } catch {
      throw new ApiError(
        HttpStatus.UNPROCESSABLE_ENTITY,
        "INVALID_IMAGE",
        "Upload must be a valid PNG, JPEG, or WebP image.",
      );
    }
    const context = currentTenantContext();
    if (context.actor.type !== "staff") throw forbidden();
    const assetId = randomUUID();
    let stored = false;
    try {
      await this.transactions.run(async (em) => {
        await this.authorize(em, "catalogWrite", requestId);
        await this.storage.write(context.tenantId, assetId, processed.variants);
        stored = true;
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
      if (stored)
        await this.storage
          .remove(context.tenantId, assetId)
          .catch(() => undefined);
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
    return this.storage.read(context.tenantId, assetId, variant);
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
