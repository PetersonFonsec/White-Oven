import { Module } from "@nestjs/common";
import {
  PublicStoreController,
  PublicStoreStatusController,
} from "./public-store-status.controller";
import { StoreController } from "./store.controller";
import { StoreService } from "./store.service";

@Module({
  controllers: [
    StoreController,
    PublicStoreStatusController,
    PublicStoreController,
  ],
  providers: [StoreService],
})
export class StoreModule {}
