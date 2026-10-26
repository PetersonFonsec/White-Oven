import { Controller, Get, Header } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { StoreTenant } from "../tenancy/store-tenant.guard";
import { StoreService } from "./store.service";

@ApiTags("public")
@Controller("public/stores/:storeSlug/status")
export class PublicStoreStatusController {
  constructor(private readonly store: StoreService) {}

  @Get()
  @StoreTenant()
  // The answer changes with the clock and with every pause, so no cache may keep it.
  @Header("Cache-Control", "no-store")
  @ApiOperation({
    summary: "Whether the store is open now, from its hours and pause",
  })
  get() {
    return this.store.getStatus();
  }
}

@ApiTags("public")
@Controller("public/stores/:storeSlug")
export class PublicStoreController {
  constructor(private readonly store: StoreService) {}

  @Get()
  @StoreTenant()
  // Revalidate on every use (ETag), like the menu: a new theme or a suspension shows at once.
  @Header("Cache-Control", "no-cache")
  @ApiOperation({
    summary:
      "The store's name and resolved brand colors, for the white label app",
  })
  get() {
    return this.store.getPublicProfile();
  }
}
