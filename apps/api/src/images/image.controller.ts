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
import { ApiError } from "../errors/api-error";
import { requestIdOf } from "../logging/request-context";
import {
  IMAGE_VARIANTS,
  type ImageVariant,
  MAX_INPUT_BYTES,
} from "./image-storage";
import { ImageService } from "./image.service";

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    if (
      !ID.test(id) ||
      !(IMAGE_VARIANTS as readonly string[]).includes(variant)
    )
      throw new ApiError(
        HttpStatus.NOT_FOUND,
        "IMAGE_NOT_FOUND",
        "Image not found.",
      );
    const image = await this.images.read(
      id,
      variant as ImageVariant,
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
