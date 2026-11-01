import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  errorSummary,
  firstError,
  validateAuthForm,
} from "../src/customer/auth-form.ts";

const filled = {
  name: "Ana Souza",
  phone: "",
  email: "ana@exemplo.com",
  password: "senha-longa-123",
  accepted: true,
};

describe("auth form", () => {
  it("asks only for e-mail and password to sign in", () => {
    assert.deepEqual(
      validateAuthForm("login", { ...filled, name: "" }, false),
      {},
    );
    assert.deepEqual(
      validateAuthForm("login", { ...filled, email: "", password: "" }, true),
      { email: "Informe seu e-mail.", password: "Informe sua senha." },
    );
    // A short password may be an old valid one: sign-in leaves it to the API.
    assert.deepEqual(
      validateAuthForm("login", { ...filled, password: "curta" }, true),
      {},
    );
  });

  it("explains every sign-up requirement next to its field", () => {
    const errors = validateAuthForm(
      "register",
      {
        name: " ",
        phone: "123",
        email: "ana@",
        password: "curta",
        accepted: false,
      },
      true,
    );
    assert.deepEqual(Object.keys(errors).sort(), [
      "email",
      "legal",
      "name",
      "password",
      "phone",
    ]);
    assert.match(errors.password!, /10 caracteres/);
    assert.match(errors.legal!, /aceite/);
    assert.equal(firstError(errors), "name");
    assert.equal(errorSummary(errors), "Há 5 campos para corrigir.");
  });

  it("accepts a valid sign-up, with or without a phone", () => {
    assert.deepEqual(validateAuthForm("register", filled, true), {});
    assert.deepEqual(
      validateAuthForm(
        "register",
        { ...filled, phone: "(11) 99999-9999" },
        true,
      ),
      {},
    );
  });

  it("does not let anyone sign up before the store's terms are loaded", () => {
    const errors = validateAuthForm("register", filled, false);
    assert.match(errors.legal!, /carregados/);
    assert.equal(firstError(errors), "legal");
    assert.equal(errorSummary(errors), "Há 1 campo para corrigir.");
    assert.equal(errorSummary({}), null);
  });
});
