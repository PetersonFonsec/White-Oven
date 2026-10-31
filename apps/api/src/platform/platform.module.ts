import { Module } from "@nestjs/common";
import {
  OwnerInviteController,
  PlatformController,
  PlatformOperatorController,
  PlatformPlanController,
  PlatformBillingController,
  PlatformLegalController,
} from "./platform.controller";
import { PlatformService } from "./platform.service";

@Module({
  controllers: [
    PlatformController,
    PlatformOperatorController,
    PlatformPlanController,
    PlatformBillingController,
    PlatformLegalController,
    OwnerInviteController,
  ],
  providers: [PlatformService],
})
export class PlatformModule {}
