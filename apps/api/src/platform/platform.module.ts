import { Module } from "@nestjs/common";
import {
  OwnerInviteController,
  PlatformController,
  PlatformOperatorController,
  PlatformPlanController,
  PlatformBillingController,
} from "./platform.controller";
import { PlatformService } from "./platform.service";

@Module({
  controllers: [
    PlatformController,
    PlatformOperatorController,
    PlatformPlanController,
    PlatformBillingController,
    OwnerInviteController,
  ],
  providers: [PlatformService],
})
export class PlatformModule {}
