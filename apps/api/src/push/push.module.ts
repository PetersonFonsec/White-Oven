import { Module } from "@nestjs/common";
import {
  CustomerSessionGuard,
  CustomerTokenGuard,
} from "../customer/customer.guard";
import { PushController } from "./push.controller";
import { PushService } from "./push.service";

@Module({
  controllers: [PushController],
  providers: [PushService, CustomerTokenGuard, CustomerSessionGuard],
})
export class PushModule {}
