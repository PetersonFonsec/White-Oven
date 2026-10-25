import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import sharp from "sharp";
import type { ApiConfig } from "../src/config/config";
import { JsonLogger } from "../src/logging/json-logger";
import { LocalImageStorage, processImage } from "../src/images/image-storage";

const logger = new JsonLogger("error", () => {});

class FailingVariantStorage extends LocalImageStorage {
  private writes = 0;
  readonly originalError = new Error("injected variant failure");

  constructor(config: ApiConfig, failAtVariant: number) {
    super(config, logger);
    this.failAtVariant = failAtVariant;
  }

  private readonly failAtVariant: number;

  protected override async writeVariant(
    directory: string,
    target: string,
    bytes: Buffer,
  ) {
    await super.writeVariant(directory, target, bytes);
    this.writes += 1;
    if (this.writes === this.failAtVariant) throw this.originalError;
  }
}

describe("M2.5 image processing and local storage", () => {
  it("sniffs PNG, JPEG and WebP bytes and emits metadata-free WebP variants", async () => {
    for (const format of ["png", "jpeg", "webp"] as const) {
      const input = await sharp({
        create: { width: 640, height: 360, channels: 3, background: "#c65d2e" },
      })
        [format]()
        .toBuffer();
      const mime = format === "jpeg" ? "image/jpeg" : `image/${format}`;
      const processed = await processImage(input, mime);
      assert.equal(processed.sourceFormat, format);
      assert.deepEqual([processed.width, processed.height], [640, 360]);
      for (const [variant, bytes] of Object.entries(processed.variants)) {
        const metadata = await sharp(bytes).metadata();
        assert.equal(metadata.format, "webp");
        const expectedWidth = variant === "thumbnail" ? 480 : 640;
        assert.deepEqual(
          [metadata.width, metadata.height],
          [expectedWidth, Math.round((360 * expectedWidth) / 640)],
        );
      }
    }
  });

  it("rejects MIME spoofing, unsupported content and uploads over the byte limit", async () => {
    await assert.rejects(processImage(Buffer.from("<svg/>"), "image/png"));
    await assert.rejects(
      processImage(Buffer.from("not an image"), "image/jpeg"),
    );
    await assert.rejects(processImage(Buffer.from("x"), "image/gif"));
    await assert.rejects(
      processImage(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png"),
    );
  });

  it("stores only generated WebP variants under tenant and opaque asset IDs", async () => {
    const root = await mkdtemp(join(tmpdir(), "whiteoven-images-"));
    const config = { imageStorageDirectory: root } as ApiConfig;
    const storage = new LocalImageStorage(config, logger);
    const tenantId = "51b7cf37-828a-4d18-8f60-804ab23e05e5";
    const assetId = "510c9890-ece7-4fa8-82b0-26171aa88af1";
    const variants = {
      thumbnail: Buffer.from("thumbnail-webp"),
      menu: Buffer.from("menu-webp"),
    };
    try {
      await storage.write(tenantId, assetId, variants);
      assert.deepEqual(
        await storage.read(tenantId, assetId, "thumbnail"),
        variants.thumbnail,
      );
      assert.deepEqual(
        await storage.read(tenantId, assetId, "menu"),
        variants.menu,
      );
      const file = join(root, "tenants", tenantId, assetId, "menu.webp");
      assert.deepEqual(await readFile(file), variants.menu);
      assert.equal((await stat(file)).mode & 0o777, 0o600);
      await assert.rejects(
        storage.read("00000000-0000-0000-0000-000000000000", assetId, "menu"),
      );
      await storage.remove(tenantId, assetId);
      await storage.remove(tenantId, assetId);
      await assert.rejects(storage.read(tenantId, assetId, "menu"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  for (const failAtVariant of [1, 2]) {
    it(`removes all partial files when variant ${failAtVariant} fails`, async () => {
      const root = await mkdtemp(join(tmpdir(), "whiteoven-images-failure-"));
      const config = { imageStorageDirectory: root } as ApiConfig;
      const storage = new FailingVariantStorage(config, failAtVariant);
      const tenantId = "51b7cf37-828a-4d18-8f60-804ab23e05e5";
      const assetId = "510c9890-ece7-4fa8-82b0-26171aa88af1";
      try {
        await assert.rejects(
          storage.write(tenantId, assetId, {
            thumbnail: Buffer.from("thumbnail"),
            menu: Buffer.from("menu"),
          }),
          (error) => error === storage.originalError,
        );
        await assert.rejects(access(join(root, "tenants", tenantId, assetId)), {
          code: "ENOENT",
        });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("does not overwrite or clean an existing asset after an ID collision", async () => {
    const root = await mkdtemp(join(tmpdir(), "whiteoven-images-collision-"));
    const config = { imageStorageDirectory: root } as ApiConfig;
    const storage = new LocalImageStorage(config, logger);
    const tenantId = "51b7cf37-828a-4d18-8f60-804ab23e05e5";
    const assetId = "510c9890-ece7-4fa8-82b0-26171aa88af1";
    const variants = {
      thumbnail: Buffer.from("original-thumbnail"),
      menu: Buffer.from("original-menu"),
    };
    try {
      await storage.write(tenantId, assetId, variants);
      await assert.rejects(
        storage.write(tenantId, assetId, {
          thumbnail: Buffer.from("replacement-thumbnail"),
          menu: Buffer.from("replacement-menu"),
        }),
      );
      assert.deepEqual(
        await storage.read(tenantId, assetId, "thumbnail"),
        variants.thumbnail,
      );
      assert.deepEqual(
        await storage.read(tenantId, assetId, "menu"),
        variants.menu,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
