import { Module } from "@nestjs/common";
import { PublicStoreStatusController } from "./public-store-status.controller";
import { StoreController } from "./store.controller";
import { StoreService } from "./store.service";

@Module({
  controllers: [StoreController, PublicStoreStatusController],
  providers: [StoreService],
})
export class StoreModule {}
