import { Module } from "@nestjs/common";
import {
  CustomerSessionGuard,
  CustomerTokenGuard,
} from "../customer/customer.guard";
import {
  AdminOrderController,
  AdminReportController,
  OrderController,
} from "./order.controller";
import { OrderHistoryService } from "./order-history.service";
import { OrderService } from "./order.service";

@Module({
  controllers: [OrderController, AdminOrderController, AdminReportController],
  providers: [
    OrderService,
    OrderHistoryService,
    CustomerTokenGuard,
    CustomerSessionGuard,
  ],
})
export class OrderModule {}
