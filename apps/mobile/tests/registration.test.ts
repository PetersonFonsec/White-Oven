import assert from "node:assert/strict";
import test from "node:test";
import { normalizeCustomerPhone } from "../src/customer/registration.ts";

test("customer phone accepts common Brazilian input and sends E.164", () => {
  assert.equal(normalizeCustomerPhone(""), null);
  assert.equal(normalizeCustomerPhone("  (11) 99999-9999 "), "+5511999999999");
  assert.equal(normalizeCustomerPhone("011 99999-9999"), "+5511999999999");
  assert.equal(normalizeCustomerPhone("55 11 99999-9999"), "+5511999999999");
  assert.equal(normalizeCustomerPhone("+44 20 1234 5678"), "+442012345678");
  assert.equal(
    normalizeCustomerPhone("telefone inválido"),
    "telefone inválido",
  );
});
