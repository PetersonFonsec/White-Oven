import { Preferences } from "../../core/tenant/preferences";
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from "@angular/core";
import { FormBuilder, ReactiveFormsModule } from "@angular/forms";
import { Router, RouterLink } from "@angular/router";
import {
  firstError,
  validateAuthForm,
  type AuthErrors,
} from "@whiteoven/customer-core/customer/auth-form";
import { normalizeCustomerPhone } from "@whiteoven/customer-core/customer/registration";
import { Addresses } from "./addresses";
import { LegalConsent, type Versions } from "./legal-consent";
import { Button, Input } from "../../design-system/primitives";
import { StoreContext } from "../../core/tenant/store-context";
import { Shop } from "../../core/commerce/shop";
@Component({
  imports: [
    ReactiveFormsModule,
    RouterLink,
    Button,
    Input,
    Addresses,
    LegalConsent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./account.page.html",
})
export class AccountPage {
  readonly prefs = inject(Preferences);
  readonly shop = inject(Shop);
  readonly store = inject(StoreContext);
  readonly mode = input<"login" | "register" | "recovery" | "verification">(
    "login",
  );
  readonly voltar = input("");
  readonly form = inject(FormBuilder).nonNullable.group({
    name: "",
    email: "",
    phone: "",
    password: "",
  });
  readonly errors = signal<AuthErrors>({});
  readonly versions = signal<Versions | null>(null);
  private readonly legal = viewChild(LegalConsent);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly router = inject(Router);
  async submit() {
    const mode = this.mode() === "register" ? "register" : "login",
      v = this.form.getRawValue(),
      versions = this.versions();
    const errors = validateAuthForm(
      mode,
      { ...v, accepted: !!versions },
      !!this.legal()?.documents(),
    );
    this.errors.set(errors);
    const first = firstError(errors);
    if (first) {
      this.host.nativeElement
        .querySelector<HTMLElement>(
          first === "legal"
            ? "wo-legal input"
            : '[formControlName="' + first + '"]',
        )
        ?.focus();
      return;
    }
    const credentials = { email: v.email.trim(), password: v.password };
    this.form.controls.password.setValue("");
    const ok = await this.shop.model?.signIn(
      mode,
      mode === "login"
        ? credentials
        : {
            ...credentials,
            name: v.name.trim(),
            phone: normalizeCustomerPhone(v.phone),
            ...versions,
          },
    );
    if (!ok && mode === "register") this.legal()?.reload();
    if (ok) {
      const next = ["checkout", "pedidos"].includes(this.voltar())
        ? this.voltar()
        : "conta";
      await this.router.navigate(["/lojas", this.store.slug(), next]);
    }
  }
  async accept() {
    const versions = this.versions();
    if (versions && !(await this.shop.model?.acceptLegal(versions)))
      this.legal()?.reload();
  }
}
