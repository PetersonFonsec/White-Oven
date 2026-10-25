import assert from "node:assert/strict";
import { HttpException } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import { describe, it } from "node:test";
import { TenantTransactions } from "../src/tenancy/tenant-transaction";
import { runWithTenantContext } from "../src/tenancy/tenant-context";
import { ApiError } from "../src/errors/api-error";
import { JsonLogger } from "../src/logging/json-logger";
import type { TenantStatus } from "../src/tenancy/tenant.entity";
import type { ImageStorage, ProcessedImage } from "../src/images/image-storage";
import { ImageService } from "../src/images/image.service";

const TENANT_ID = "51b7cf37-828a-4d18-8f60-804ab23e05e5";
const STAFF_ID = "842bb248-718f-4e0f-85ee-43d0c522e233";
const SESSION_ID = "e2191913-2cc9-4ee5-94d3-34fd2ba80636";
const ASSET_ID = "510c9890-ece7-4fa8-82b0-26171aa88af1";
const REQUEST_ID = "0a0b0c0d-1111-4222-8333-444455556666";

const processedImage: ProcessedImage = {
  sourceFormat: "png",
  width: 32,
  height: 24,
  variants: {
    thumbnail: Buffer.from("thumbnail"),
    menu: Buffer.from("menu"),
  },
};

interface HarnessOptions {
  role?: "OWNER" | "MANAGER" | "STAFF";
  status?: TenantStatus;
  insertError?: Error;
  commitError?: Error;
  revokeBeforeSecondTransaction?: boolean;
  removeError?: Error;
  imageVisible?: boolean;
  readError?: NodeJS.ErrnoException;
  processor?: () => Promise<ProcessedImage>;
}

function harness(options: HarnessOptions = {}) {
  let status = options.status ?? "ACTIVE";
  let activeTransaction = false;
  let transactionCount = 0;
  const logLines: Record<string, unknown>[] = [];
  const logger = new JsonLogger("debug", (line) =>
    logLines.push(JSON.parse(line) as Record<string, unknown>),
  );
  const storageCalls = { write: 0, remove: 0, read: 0 };
  const storage: ImageStorage = {
    async write() {
      storageCalls.write += 1;
    },
    async read() {
      storageCalls.read += 1;
      if (options.readError) throw options.readError;
      return Buffer.from("webp");
    },
    async remove() {
      storageCalls.remove += 1;
      if (options.removeError) throw options.removeError;
    },
  };
  const em = {
    async execute(query: string) {
      if (query.includes("set_config")) return [];
      if (query.includes("select status from tenants")) return [{ status }];
      if (query.includes("select id from image_assets"))
        return options.imageVisible === false ? [] : [{ id: ASSET_ID }];
      if (query.startsWith("insert into image_assets") && options.insertError)
        throw options.insertError;
      return [];
    },
  };
  const transactions = {
    async run<T>(work: (manager: EntityManager) => Promise<T>) {
      transactionCount += 1;
      if (options.revokeBeforeSecondTransaction && transactionCount === 2)
        throw new ApiError(
          403,
          "TENANT_ACCESS_DENIED",
          "No access to this store.",
        );
      activeTransaction = true;
      try {
        const result = await work(em as unknown as EntityManager);
        if (transactionCount === 2 && options.commitError)
          throw options.commitError;
        return result;
      } finally {
        activeTransaction = false;
      }
    },
  };
  const processor =
    options.processor ??
    (async () => {
      assert.equal(
        activeTransaction,
        false,
        "image processing must be outside a transaction",
      );
      return processedImage;
    });
  const service = new ImageService(
    transactions as unknown as TenantTransactions,
    storage,
    processor,
    logger,
  );
  const withActor = <T>(
    work: () => Promise<T>,
    role = options.role ?? "OWNER",
  ) =>
    runWithTenantContext(
      {
        tenantId: TENANT_ID,
        actor: {
          type: "staff",
          staffUserId: STAFF_ID,
          sessionId: SESSION_ID,
          role,
        },
      },
      work,
    );
  return {
    service,
    storageCalls,
    logLines,
    withActor,
    setStatus(value: TenantStatus) {
      status = value;
    },
  };
}

describe("M2.5 image service authorization and compensation", () => {
  it("rejects an unauthorized upload before invoking the image processor", async () => {
    let processed = false;
    const app = harness({
      role: "STAFF",
      processor: async () => {
        processed = true;
        return processedImage;
      },
    });
    await assert.rejects(
      app.withActor(() =>
        app.service.upload(Buffer.from("invalid"), "image/png", REQUEST_ID),
      ),
      (error: unknown) =>
        error instanceof HttpException && error.getStatus() === 403,
    );
    assert.equal(processed, false);
    assert.equal(app.storageCalls.write, 0);
  });

  it("rejects catalog writes for a suspended tenant before image processing", async () => {
    let processed = false;
    const app = harness({
      status: "SUSPENDED",
      processor: async () => {
        processed = true;
        return processedImage;
      },
    });
    await assert.rejects(
      app.withActor(() =>
        app.service.upload(Buffer.from("invalid"), "image/png", REQUEST_ID),
      ),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "CATALOG_WRITE_FORBIDDEN" &&
        error.getStatus() === 403,
    );
    assert.equal(processed, false);
  });

  it("revalidates access after processing and prevents persistence after revocation", async () => {
    let processed = false;
    const app = harness({
      revokeBeforeSecondTransaction: true,
      processor: async () => {
        processed = true;
        return processedImage;
      },
    });
    await assert.rejects(
      app.withActor(() =>
        app.service.upload(Buffer.from("image"), "image/png", REQUEST_ID),
      ),
      (error: unknown) =>
        error instanceof ApiError && error.code === "TENANT_ACCESS_DENIED",
    );
    assert.equal(processed, true);
    assert.equal(app.storageCalls.write, 0);
    assert.equal(app.storageCalls.remove, 0);
  });

  it("allows OWNER and MANAGER uploads with processing outside both transactions", async () => {
    for (const role of ["OWNER", "MANAGER"] as const) {
      const app = harness({ role });
      const result = await app.withActor(
        () => app.service.upload(Buffer.from("image"), "image/png", REQUEST_ID),
        role,
      );
      assert.equal(result.width, 32);
      assert.equal(app.storageCalls.write, 1);
    }
  });

  it("compensates an insert failure, logs failed cleanup and preserves the database error", async () => {
    const insertError = Object.assign(new Error("database insert failed"), {
      code: "XX000",
    });
    const app = harness({
      insertError,
      removeError: new Error("filesystem failed"),
    });
    await assert.rejects(
      app.withActor(() =>
        app.service.upload(Buffer.from("image"), "image/png", REQUEST_ID),
      ),
      (error: unknown) => error === insertError,
    );
    assert.equal(app.storageCalls.write, 1);
    assert.equal(app.storageCalls.remove, 1);
    const event = app.logLines.find(
      (line) => line.event === "image_storage.compensation_failed",
    );
    assert.ok(event);
    assert.equal(event.tenantId, TENANT_ID);
    assert.match(String(event.assetId), /^[0-9a-f-]{36}$/i);
    assert.equal(event.originalErrorType, "Error");
    assert.equal(event.cleanupErrorType, "Error");
    assert.equal(JSON.stringify(event).includes("filesystem failed"), false);
  });

  it("compensates when the PostgreSQL transaction fails during commit", async () => {
    const commitError = new Error("commit failed");
    const app = harness({ commitError });
    await assert.rejects(
      app.withActor(() =>
        app.service.upload(Buffer.from("image"), "image/png", REQUEST_ID),
      ),
      (error: unknown) => error === commitError,
    );
    assert.equal(app.storageCalls.write, 1);
    assert.equal(app.storageCalls.remove, 1);
  });

  it("distinguishes a missing tenant asset from a missing physical variant", async () => {
    const app = harness({ imageVisible: false });
    await assert.rejects(
      app.withActor(() => app.service.read(ASSET_ID, "menu", REQUEST_ID)),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "IMAGE_NOT_FOUND" &&
        error.getStatus() === 404,
    );
    assert.equal(app.storageCalls.read, 0);

    const missingFile = Object.assign(new Error("private filesystem path"), {
      code: "ENOENT",
    }) as NodeJS.ErrnoException;
    const missingFileApp = harness({ readError: missingFile });
    await assert.rejects(
      missingFileApp.withActor(() =>
        missingFileApp.service.read(ASSET_ID, "menu", REQUEST_ID),
      ),
      (error: unknown) =>
        error instanceof ApiError &&
        error.code === "IMAGE_STORAGE_MISSING" &&
        error.getStatus() === 503 &&
        !error.message.includes("filesystem"),
    );
    const event = missingFileApp.logLines.find(
      (line) => line.event === "image_storage.variant_missing",
    );
    assert.equal(event?.tenantId, TENANT_ID);
    assert.equal(event?.variant, "menu");
  });

  it("does not disguise unexpected storage I/O errors as not found", async () => {
    const ioError = Object.assign(new Error("permission denied"), {
      code: "EACCES",
    }) as NodeJS.ErrnoException;
    const app = harness({ readError: ioError });
    await assert.rejects(
      app.withActor(() => app.service.read(ASSET_ID, "menu", REQUEST_ID)),
      (error: unknown) => error === ioError,
    );
    assert.equal(
      app.logLines.some(
        (line) => line.event === "image_storage.variant_missing",
      ),
      false,
    );
  });
});
