import { defineEntity, p } from "@mikro-orm/core";
import { tenantFilters } from "../tenancy/tenant-filter";

export const ImageAsset = defineEntity({
  name: "ImageAsset",
  tableName: "image_assets",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    sourceFormat: p.enum(["jpeg", "png", "webp"]),
    width: p.integer(),
    height: p.integer(),
    createdAt: p.datetime(),
  },
});
