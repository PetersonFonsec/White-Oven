import { Module } from "@nestjs/common";
import { CatalogController } from "./catalog.controller";
import { CatalogService } from "./catalog.service";
import { PublicMenuController } from "./public-menu.controller";
import { PublicMenuService } from "./public-menu.service";

@Module({
  controllers: [CatalogController, PublicMenuController],
  providers: [CatalogService, PublicMenuService],
})
export class CatalogModule {}
