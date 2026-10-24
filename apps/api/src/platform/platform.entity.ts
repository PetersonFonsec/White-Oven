import { defineEntity, p } from "@mikro-orm/core";
import { tenantFilters } from "../tenancy/tenant-filter";

export const Order = defineEntity({
  name: "Order",
  tableName: "orders",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    status: p.enum(["PLACED", "REJECTED"]),
    rejectionReason: p.text().nullable(),
    placedAt: p.datetime(),
    updatedAt: p.datetime(),
  },
});

export const OwnerInvite = defineEntity({
  name: "OwnerInvite",
  tableName: "owner_invites",
  filters: tenantFilters,
  properties: {
    id: p.uuid().primary(),
    tenantId: p.uuid(),
    email: p.text(),
    tokenHash: p.blob().lazy(),
    expiresAt: p.datetime(),
    acceptedAt: p.datetime().nullable(),
    createdBy: p.uuid(),
    createdAt: p.datetime(),
  },
});
