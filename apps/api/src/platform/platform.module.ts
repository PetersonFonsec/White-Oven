import { Module } from "@nestjs/common";
import {
  OwnerInviteController,
  PlatformController,
  PlatformOperatorController,
} from "./platform.controller";
import { PlatformService } from "./platform.service";

@Module({
  controllers: [
    PlatformController,
    PlatformOperatorController,
    OwnerInviteController,
  ],
  providers: [PlatformService],
})
export class PlatformModule {}
