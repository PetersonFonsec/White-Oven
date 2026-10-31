import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import sharp from "sharp";
import type { ApiConfig } from "../config/config";
import { API_CONFIG } from "../config/config";
import { JsonLogger } from "../logging/json-logger";

export const IMAGE_STORAGE = Symbol("IMAGE_STORAGE");
export const IMAGE_PROCESSOR = Symbol("IMAGE_PROCESSOR");
export const IMAGE_VARIANTS = ["thumbnail", "menu"] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];
export type ImageVariantBuffers = Record<ImageVariant, Buffer>;

/**
 * Implementations must make `write` all-or-clean: if it rejects, it must remove any variants
 * created by that call whenever possible and rethrow the original write error. A successful
 * `write` owns exactly this tenant/asset pair until `remove`; `remove` is idempotent and must not
 * affect any other asset or tenant. Callers compensate a successful write if database commit
 * later fails.
 */
export interface ImageStorage {
  write(
    tenantId: string,
    assetId: string,
    variants: ImageVariantBuffers,
  ): Promise<void>;
  read(
    tenantId: string,
    assetId: string,
    variant: ImageVariant,
  ): Promise<Buffer>;
  remove(tenantId: string, assetId: string): Promise<void>;
}

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_INPUT_PIXELS = 30_000_000;
const ACCEPTED_MIME: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/png": "png",
  "image/webp": "webp",
};

export interface ProcessedImage {
  sourceFormat: "jpeg" | "png" | "webp";
  width: number;
  height: number;
  variants: ImageVariantBuffers;
}

export type ImageProcessor = typeof processImage;

export async function processImage(
  bytes: Buffer,
  contentType: string,
): Promise<ProcessedImage> {
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length === 0 ||
    bytes.length > MAX_INPUT_BYTES
  )
    throw new Error("invalid image size");
  const expectedFormat = ACCEPTED_MIME[contentType.toLowerCase()];
  if (!expectedFormat) throw new Error("unsupported image media type");

  const image = sharp(bytes, {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
  });
  const metadata = await image.metadata();
  if (
    metadata.format !== expectedFormat ||
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height > MAX_INPUT_PIXELS ||
    (metadata.pages ?? 1) > 1
  )
    throw new Error("invalid or unsupported image content");

  const makeVariant = (size: number) =>
    sharp(bytes, { failOn: "error", limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize(size, size, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 })
      .toBuffer();
  const [thumbnail, menu] = await Promise.all([
    makeVariant(480),
    makeVariant(1600),
  ]);
  return {
    sourceFormat: metadata.format as ProcessedImage["sourceFormat"],
    width: metadata.width,
    height: metadata.height,
    variants: { thumbnail, menu },
  };
}

@Injectable()
export class LocalImageStorage implements ImageStorage {
  private readonly root: string;

  constructor(
    @Inject(API_CONFIG) config: ApiConfig,
    @Inject(JsonLogger) private readonly logger: JsonLogger,
  ) {
    this.root = resolve(config.imageStorageDirectory);
  }

  async write(
    tenantId: string,
    assetId: string,
    variants: ImageVariantBuffers,
  ) {
    const directory = this.assetDirectory(tenantId, assetId);
    const parent = dirname(directory);
    let createdAssetDirectory = false;
    try {
      await mkdir(parent, { recursive: true, mode: 0o700 });
      // The asset directory must be new. This prevents a UUID collision from overwriting or
      // cleaning files owned by an earlier asset.
      await mkdir(directory, { mode: 0o700 });
      createdAssetDirectory = true;
      for (const variant of IMAGE_VARIANTS) {
        await this.writeVariant(
          directory,
          join(directory, `${variant}.webp`),
          variants[variant],
        );
      }
      // The caller commits the metadata after this returns; the names must survive a crash.
      await syncDirectory(directory);
      await syncDirectory(parent);
    } catch (error) {
      if (createdAssetDirectory) {
        try {
          await rm(directory, { recursive: true, force: true });
        } catch (cleanupError) {
          try {
            this.logger.write(
              "error",
              "image storage partial write cleanup failed",
              {
                event: "image_storage.partial_write_cleanup_failed",
                operation: "write",
                tenantId,
                assetId,
                errorType: errorType(cleanupError),
              },
            );
          } catch {
            // Logging must not replace the original storage write failure.
          }
        }
      }
      throw error;
    }
  }

  read(tenantId: string, assetId: string, variant: ImageVariant) {
    return readFile(this.path(tenantId, assetId, variant));
  }

  async remove(tenantId: string, assetId: string) {
    await rm(this.assetDirectory(tenantId, assetId), {
      recursive: true,
      force: true,
    });
  }

  private path(tenantId: string, assetId: string, variant: ImageVariant) {
    return join(this.assetDirectory(tenantId, assetId), `${variant}.webp`);
  }

  private assetDirectory(tenantId: string, assetId: string) {
    if (!UUID.test(tenantId) || !UUID.test(assetId))
      throw new Error("invalid image storage identifier");
    return join(this.root, "tenants", tenantId, assetId);
  }

  protected async writeVariant(
    directory: string,
    target: string,
    bytes: Buffer,
  ) {
    const temporary = join(
      directory,
      `${basename(target)}.${randomUUID()}.tmp`,
    );
    // Published under its final name only complete and on disk: a reader or a backup sees the
    // whole variant or none of it (temporary names end in .tmp and are not backed up).
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, target);
  }
}

async function syncDirectory(path: string) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const errorType = (error: unknown) =>
  error instanceof Error ? error.constructor.name : typeof error;

export { MAX_INPUT_BYTES };
