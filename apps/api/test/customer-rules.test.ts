import assert from "node:assert/strict";
import { test } from "node:test";
import {
  validateAddress,
  validateRegistration,
} from "../src/customer/customer-rules";

const registration = {
  name: "Ana",
  email: "ana@exemplo.com.br",
  password: "uma-senha-longa",
  privacyPolicyVersion: "2026-10",
};
const address = {
  label: "Casa",
  postalCode: "01310100",
  street: "Avenida Paulista",
  number: "1000",
  district: "Bela Vista",
  city: "São Paulo",
  state: "SP",
};
const paths = (result: { ok: boolean; paths?: string[] }) =>
  result.ok ? [] : [...result.paths!].sort();

test("customer rules: a registration is trimmed, its e-mail lower-cased, phone optional", () => {
  assert.deepEqual(
    validateRegistration({
      ...registration,
      name: " Ana ",
      email: " Ana@Exemplo.com.BR ",
    }),
    {
      ok: true,
      value: { ...registration, phone: null },
    },
  );
  for (const phone of [null, "", "  "])
    assert.equal(
      (
        validateRegistration({ ...registration, phone }) as {
          value: { phone: null };
        }
      ).value.phone,
      null,
    );
  assert.equal(
    (
      validateRegistration({ ...registration, phone: "+5511999990000" }) as {
        value: { phone: string };
      }
    ).value.phone,
    "+5511999990000",
  );
});

test("customer rules: a registration reports every bad or unknown field", () => {
  assert.deepEqual(paths(validateRegistration(null)), [""]);
  assert.deepEqual(paths(validateRegistration({})), [
    "email",
    "name",
    "password",
    "privacyPolicyVersion",
  ]);
  assert.deepEqual(
    paths(
      validateRegistration({
        ...registration,
        name: "x".repeat(121),
        email: "a@b",
        password: "curta",
        phone: "(11) 99999-0000",
        privacyPolicyVersion: "v".repeat(41),
        role: "OWNER",
      }),
    ),
    ["email", "name", "password", "phone", "privacyPolicyVersion", "role"],
  );
  assert.deepEqual(
    paths(validateRegistration({ ...registration, password: "senha12345" })),
    ["password"],
  );
});

test("customer rules: an address keeps CEP digits and an upper-case UF, blanks become null", () => {
  assert.deepEqual(
    validateAddress({
      ...address,
      postalCode: " 01310-100 ",
      state: "sp",
      complement: " ",
      reference: " Perto do metrô ",
    }),
    {
      ok: true,
      value: {
        ...address,
        complement: null,
        reference: "Perto do metrô",
      },
    },
  );
});

test("customer rules: an address reports every bad or unknown field", () => {
  assert.deepEqual(paths(validateAddress([])), [""]);
  assert.deepEqual(
    paths(
      validateAddress({
        ...address,
        label: "",
        postalCode: "0131010",
        street: 12,
        state: "SPX",
        complement: "c".repeat(61),
        latitude: -23.5,
      }),
    ),
    ["complement", "label", "latitude", "postalCode", "state", "street"],
  );
});
