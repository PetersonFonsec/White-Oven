import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import sharp from "sharp";
import type { ApiConfig } from "../config/config";
import { API_CONFIG } from "../config/config";

export const IMAGE_STORAGE = Symbol("IMAGE_STORAGE");
export const IMAGE_VARIANTS = ["thumbnail", "menu"] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];
export type ImageVariantBuffers = Record<ImageVariant, Buffer>;

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

  constructor(@Inject(API_CONFIG) config: ApiConfig) {
    this.root = resolve(config.imageStorageDirectory);
  }

  async write(
    tenantId: string,
    assetId: string,
    variants: ImageVariantBuffers,
  ) {
    const targets = IMAGE_VARIANTS.map((variant) => ({
      target: this.path(tenantId, assetId, variant),
      bytes: variants[variant],
    }));
    const temporary: string[] = [];
    try {
      for (const { target, bytes } of targets) {
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        const temp = `${target}.${randomUUID()}.tmp`;
        temporary.push(temp);
        await writeFile(temp, bytes, { flag: "wx", mode: 0o600 });
        await rename(temp, target);
      }
    } catch (error) {
      await Promise.all(temporary.map((path) => rm(path, { force: true })));
      await Promise.all(
        targets.map(({ target }) => rm(target, { force: true })),
      );
      throw error;
    }
  }

  read(tenantId: string, assetId: string, variant: ImageVariant) {
    return readFile(this.path(tenantId, assetId, variant));
  }

  async remove(tenantId: string, assetId: string) {
    const directory = dirname(this.path(tenantId, assetId, "thumbnail"));
    await rm(directory, { recursive: true, force: true });
  }

  private path(tenantId: string, assetId: string, variant: ImageVariant) {
    // Callers use validated UUIDs; fixed variants and generated IDs prevent path traversal.
    return join(this.root, "tenants", tenantId, assetId, `${variant}.webp`);
  }
}

export { MAX_INPUT_BYTES };
