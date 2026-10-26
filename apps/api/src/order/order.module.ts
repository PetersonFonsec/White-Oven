import { Module } from "@nestjs/common";
import {
  CustomerSessionGuard,
  CustomerTokenGuard,
} from "../customer/customer.guard";
import { AdminOrderController, OrderController } from "./order.controller";
import { OrderService } from "./order.service";

@Module({
  controllers: [OrderController, AdminOrderController],
  providers: [OrderService, CustomerTokenGuard, CustomerSessionGuard],
})
export class OrderModule {}
