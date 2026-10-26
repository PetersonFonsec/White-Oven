import { Module } from "@nestjs/common";
import { CustomerAddresses } from "./customer-address.service";
import { CUSTOMER_LOGIN_THROTTLE, CustomerAuth } from "./customer-auth.service";
import { CustomerController } from "./customer.controller";
import { CustomerLoginThrottle } from "./customer-login-throttle";
import { CustomerSessionGuard, CustomerTokenGuard } from "./customer.guard";

@Module({
  controllers: [CustomerController],
  providers: [
    {
      provide: CUSTOMER_LOGIN_THROTTLE,
      useFactory: () => new CustomerLoginThrottle(),
    },
    CustomerAuth,
    CustomerAddresses,
    CustomerTokenGuard,
    CustomerSessionGuard,
  ],
})
export class CustomerModule {}
