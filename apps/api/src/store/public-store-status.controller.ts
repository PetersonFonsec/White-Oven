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
