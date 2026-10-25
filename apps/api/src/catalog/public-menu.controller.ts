import { Controller, Get, Header } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { StoreTenant } from "../tenancy/store-tenant.guard";
import { PublicMenuService } from "./public-menu.service";

@ApiTags("public")
@Controller("public/stores/:storeSlug/menu")
export class PublicMenuController {
  constructor(private readonly menu: PublicMenuService) {}

  @Get()
  @StoreTenant()
  // Revalidate on every use (ETag): a store suspended or edited must not be served from a cache.
  @Header("Cache-Control", "no-cache")
  @ApiOperation({
    summary: "Get the store's public menu with orderable items only",
  })
  get() {
    return this.menu.get();
  }
}
