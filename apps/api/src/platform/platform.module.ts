import { Module } from "@nestjs/common";
import {
  OwnerInviteController,
  PlatformController,
  PlatformOperatorController,
  PlatformPlanController,
} from "./platform.controller";
import { PlatformService } from "./platform.service";

@Module({
  controllers: [
    PlatformController,
    PlatformOperatorController,
    PlatformPlanController,
    OwnerInviteController,
  ],
  providers: [PlatformService],
})
export class PlatformModule {}
