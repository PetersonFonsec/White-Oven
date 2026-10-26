import { Module } from "@nestjs/common";
import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";
import { PublicMenuController } from "./public-menu.controller";
import { PublicMenuService } from "./public-menu.service";

@Module({
  controllers: [CatalogController, PublicMenuController],
  providers: [CatalogService, PublicMenuService],
  // One instance, so the public images share the menu's cache (M5.2).
  exports: [PublicMenuService],
})
export class CatalogModule {}
