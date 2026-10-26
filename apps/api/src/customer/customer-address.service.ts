import { HttpStatus, Injectable } from "@nestjs/common";
import type { EntityManager } from "@mikro-orm/postgresql";
import { ApiError } from "../errors/api-error";
import { TenantTransactions } from "../tenancy/tenant-transaction";
import { customerOf } from "./customer-auth.service";
import {
  ADDRESSES_PER_CUSTOMER_MAX,
  type CustomerAddress,
} from "./customer-rules";

export interface SavedAddress extends CustomerAddress {
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COLUMNS = `id, label, postal_code as "postalCode", street, number, complement, district,
  city, state, reference`;

/** Another customer's address, of this store or any other, is the same 404 as a missing one. */
const addressNotFound = () =>
  new ApiError(HttpStatus.NOT_FOUND, "NOT_FOUND", "Address not found.");

/**
 * The signed-in customer's own addresses (M4.2). Every statement filters by the customer, and
 * RLS by the store, so neither another customer nor another store's address can be read or
 * changed. Orders will copy the address (snapshot), so editing one never changes an order.
 */
@Injectable()
export class CustomerAddresses {
  constructor(private readonly transactions: TenantTransactions) {}

  list(): Promise<SavedAddress[]> {
    return this.transactions.run((em) =>
      em.execute<SavedAddress[]>(
        `select ${COLUMNS} from customer_addresses where customer_id = ? order by created_at, id`,
        [customerOf()],
      ),
    );
  }

  /**
   * The advisory lock of `lockCustomer` serializes creations for one customer, so the count and
   * the insert below see every address committed before: two requests at 9 addresses give one
   * 201 and one 409. No row lock is upgraded (the session check holds the customer row FOR
   * SHARE), so concurrent creations queue instead of deadlocking.
   */
  create(address: CustomerAddress): Promise<SavedAddress> {
    return this.transactions.run(
      async (em) => {
        const customerId = customerOf();
        const [count] = await em.execute<{ count: number }[]>(
          "select count(*)::int as count from customer_addresses where customer_id = ?",
          [customerId],
        );
        if (count!.count >= ADDRESSES_PER_CUSTOMER_MAX)
          throw new ApiError(
            HttpStatus.CONFLICT,
            "ADDRESS_LIMIT_REACHED",
            `At most ${ADDRESSES_PER_CUSTOMER_MAX} addresses per account.`,
          );
        const [row] = await em.execute<SavedAddress[]>(
          `insert into customer_addresses (tenant_id, customer_id, label, postal_code, street, number,
             complement, district, city, state, reference)
           values (current_setting('app.tenant_id')::uuid, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           returning ${COLUMNS}`,
          [customerId, ...values(address)],
        );
        return row!;
      },
      { lockCustomer: true },
    );
  }

  update(id: string, address: CustomerAddress): Promise<SavedAddress> {
    if (!UUID.test(id)) throw addressNotFound();
    return this.transactions.run(async (em) => {
      const [row] = await em.execute<SavedAddress[]>(
        `update customer_addresses
            set label = ?, postal_code = ?, street = ?, number = ?, complement = ?, district = ?,
                city = ?, state = ?, reference = ?, updated_at = now()
          where id = ? and customer_id = ?
          returning ${COLUMNS}`,
        [...values(address), id, customerOf()],
      );
      if (!row) throw addressNotFound();
      return row;
    });
  }

  async remove(id: string): Promise<void> {
    if (!UUID.test(id)) throw addressNotFound();
    await this.transactions.run(async (em: EntityManager) => {
      const rows = await em.execute(
        "delete from customer_addresses where id = ? and customer_id = ? returning id",
        [id, customerOf()],
      );
      if (rows.length === 0) throw addressNotFound();
    });
  }
}

const values = (address: CustomerAddress) => [
  address.label,
  address.postalCode,
  address.street,
  address.number,
  address.complement,
  address.district,
  address.city,
  address.state,
  address.reference,
];
