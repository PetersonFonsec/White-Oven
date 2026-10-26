import {
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";
import { AdminRoute } from "../auth/staff.guard";
import { StoreTenant } from "../tenancy/store-tenant.guard";
import { ApiError } from "../errors/api-error";
import { requestIdOf } from "../logging/request-context";
import {
  IMAGE_VARIANTS,
  type ImageVariant,
  MAX_INPUT_BYTES,
} from "./image-storage";
import { ImageService } from "./image.service";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same 404 for a malformed id or variant as for an unknown image. */
function checkedVariant(id: string, variant: string): ImageVariant {
  if (!ID.test(id) || !(IMAGE_VARIANTS as readonly string[]).includes(variant))
    throw new ApiError(
      HttpStatus.NOT_FOUND,
      "IMAGE_NOT_FOUND",
      "Image not found.",
    );
  return variant as ImageVariant;
}

@ApiTags("images")
@ApiBearerAuth()
@Controller("admin/catalog/images")
export class ImageController {
  constructor(private readonly images: ImageService) {}

  @Post()
  @AdminRoute("OWNER", "MANAGER")
  @ApiConsumes("image/png", "image/jpeg", "image/webp")
  @ApiOperation({ summary: "Upload and process a tenant catalog image" })
  async upload(@Req() req: Request) {
    const contentType =
      req.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (!new Set(["image/png", "image/jpeg", "image/webp"]).has(contentType))
      throw new ApiError(
        HttpStatus.UNSUPPORTED_MEDIA_TYPE,
        "UNSUPPORTED_IMAGE_TYPE",
        "Upload must use PNG, JPEG, or WebP.",
      );
    const length = Number(req.get("content-length"));
    if (Number.isFinite(length) && length > MAX_INPUT_BYTES)
      throw new ApiError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        "IMAGE_TOO_LARGE",
        "Image exceeds the 5 MiB upload limit.",
      );
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += part.length;
      if (size > MAX_INPUT_BYTES) {
        tooLarge = true;
        continue;
      }
      chunks.push(part);
    }
    if (tooLarge)
      throw new ApiError(
        HttpStatus.PAYLOAD_TOO_LARGE,
        "IMAGE_TOO_LARGE",
        "Image exceeds the 5 MiB upload limit.",
      );
    return this.images.upload(
      Buffer.concat(chunks),
      contentType,
      requestIdOf(req),
    );
  }

  @Get(":id/:variant")
  @AdminRoute("OWNER", "MANAGER")
  @ApiProduces("image/webp")
  @ApiOperation({ summary: "Read a tenant catalog image variant" })
  async read(
    @Param("id") id: string,
    @Param("variant") variant: string,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const image = await this.images.read(
      id,
      checkedVariant(id, variant),
      requestIdOf(req),
    );
    res
      .status(HttpStatus.OK)
      .type("image/webp")
      .set("Cache-Control", "private, no-store")
      .set("X-Content-Type-Options", "nosniff")
      .send(image);
  }
}

/**
 * Images of the store's public surface, for the app (M5.2, ADR 0021): the menu's flavor and
 * product images and the brand logo, nothing else.
 */
@ApiTags("public")
@Controller("public/stores/:storeSlug/images")
export class PublicImageController {
  constructor(private readonly images: ImageService) {}

  @Get(":id/:variant")
  @StoreTenant()
  @ApiProduces("image/webp")
  @ApiOperation({
    summary: "Read an image the store's public menu or brand shows",
  })
  async read(
    @Param("id") id: string,
    @Param("variant") variant: string,
    @Res() res: Response,
  ) {
    const image = await this.images.readPublic(id, checkedVariant(id, variant));
    res
      .status(HttpStatus.OK)
      .type("image/webp")
      // Revalidated on every use (ETag), like the menu: an image taken off the menu or a
      // suspended store stops being served at once, and an unchanged one costs a 304.
      .set("Cache-Control", "no-cache")
      .set("X-Content-Type-Options", "nosniff")
      .send(image);
  }
}
