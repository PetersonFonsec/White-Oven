import { Module } from "@nestjs/common";
import { LoginThrottle } from "../auth/login-throttle";
import { CustomerAddresses } from "./customer-address.service";
import { CUSTOMER_LOGIN_THROTTLE, CustomerAuth } from "./customer-auth.service";
import { CustomerController } from "./customer.controller";
import { CustomerSessionGuard, CustomerTokenGuard } from "./customer.guard";

@Module({
  controllers: [CustomerController],
  providers: [
    { provide: CUSTOMER_LOGIN_THROTTLE, useFactory: () => new LoginThrottle() },
    CustomerAuth,
    CustomerAddresses,
    CustomerTokenGuard,
    CustomerSessionGuard,
  ],
})
export class CustomerModule {}
