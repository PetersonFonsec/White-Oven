import {
  PaymentMethodSelector,
  PriceSummary,
} from "../../design-system/commerce-controls";
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { FormBuilder, ReactiveFormsModule } from "@angular/forms";
import { RouterLink } from "@angular/router";
import { takeUntilDestroyed, toSignal } from "@angular/core/rxjs-interop";
import { formatCents } from "@whiteoven/customer-core/menu/menu";
import { moneyInput } from "@whiteoven/customer-core/cart/summary";
import { checkoutAction } from "@whiteoven/customer-core/cart/checkout-flow";
import type { CheckoutDetails } from "@whiteoven/customer-core/cart/cart";
import { retryAllowed } from "@whiteoven/customer-core/cart/model";
import { StoreContext } from "../../core/tenant/store-context";
import { Button, Input } from "../../design-system/primitives";
import { Bag } from "./bag";
@Component({
  providers: [Bag],
  imports: [
    RouterLink,
    ReactiveFormsModule,
    Button,
    Input,
    PaymentMethodSelector,
    PriceSummary,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./checkout.page.html",
})
export class CheckoutPage {
  readonly bag = inject(Bag);
  readonly shop = this.bag.shop;
  readonly store = inject(StoreContext);
  readonly money = formatCents;
  readonly error = signal("");
  readonly form = inject(FormBuilder).nonNullable.group({
    fulfillment: "",
    addressId: "",
    paymentMethod: "",
    change: "",
    notes: "",
  });
  private readonly values = toSignal(this.form.valueChanges, {
    initialValue: this.form.getRawValue(),
  });
  readonly action = computed(() => {
    const s = this.shop.state(),
      v = this.values(),
      settings = this.store.checkout();
    return checkoutAction(
      {
        ready: !!s?.ready,
        busy: !!s?.busy,
        pending: !!s?.pending,
        empty: !s?.cart.length,
        unavailableItems: this.bag.subtotal() === null,
        stale: this.bag.catalog.status() !== "ready",
        canOrder: this.store.availability() === "open",
        settingsLoaded: !!settings,
        signedIn: !!s?.profile,
        delivery: v.fulfillment === "DELIVERY",
        addressChosen: !!s?.addresses.some((a) => a.id === v.addressId),
      },
      !!s?.quote,
    );
  });
  private readonly terms = computed(() => {
    const settings = this.store.checkout();
    const v = this.values();
    let change: number | null | "invalid" = null;
    if (v.paymentMethod === "CASH") {
      try {
        change = moneyInput(v.change ?? "");
      } catch {
        change = "invalid";
      }
    }
    return JSON.stringify([
      this.bag.catalog.menu()?.version,
      this.store.availability(),
      this.bag.catalog.status() === "stale",
      settings?.minimumOrderCents,
      v.fulfillment,
      v.paymentMethod,
      v.notes?.trim(),
      v.fulfillment === "DELIVERY"
        ? [
            v.addressId,
            settings?.deliveryFeeCents,
            settings?.deliveryAreaDescription,
          ]
        : settings?.pickupAddress,
      change,
      settings?.fulfillmentModes.some((mode) => mode === v.fulfillment),
      settings?.acceptedPaymentMethods.some(
        (method) => method === v.paymentMethod,
      ),
    ]);
  });
  private quotedTerms?: string;
  private checkTerms() {
    if (this.quotedTerms !== undefined && this.quotedTerms !== this.terms()) {
      this.quotedTerms = undefined;
      this.shop.model?.invalidateQuote();
    }
  }
  constructor() {
    const destroy = inject(DestroyRef);
    this.form.valueChanges.pipe(takeUntilDestroyed()).subscribe(() => {
      this.checkTerms();
      this.error.set("");
    });
    effect(() => {
      const settings = this.store.checkout();
      this.terms();
      untracked(() => {
        this.checkTerms();
        if (!settings) return;
        const current = this.form.getRawValue();
        if (
          !settings.fulfillmentModes.includes(
            current.fulfillment as CheckoutDetails["fulfillment"],
          )
        )
          this.form.controls.fulfillment.setValue(
            settings.fulfillmentModes[0]!,
          );
        if (
          !settings.acceptedPaymentMethods.includes(
            current.paymentMethod as CheckoutDetails["paymentMethod"],
          )
        )
          this.form.controls.paymentMethod.setValue(
            settings.acceptedPaymentMethods[0]!,
          );
      });
    });
    destroy.onDestroy(() => this.shop.model?.invalidateQuote());
  }
  canRetry() {
    const pending = this.shop.state()?.pending;
    return !!pending && retryAllowed(pending, Date.now());
  }
  async submit() {
    this.checkTerms();
    const s = this.shop.state(),
      action = this.action();
    if (!s?.profile || s.profile.legalUpdateRequired) return;
    if (action.kind === "confirm") {
      await this.shop.model?.confirm();
      return;
    }
    if (action.kind !== "quote") return;
    const v = this.form.getRawValue(),
      settings = this.store.checkout()!;
    try {
      const fulfillment = v.fulfillment as CheckoutDetails["fulfillment"],
        paymentMethod = v.paymentMethod as CheckoutDetails["paymentMethod"];
      if (
        !settings.fulfillmentModes.includes(fulfillment) ||
        !settings.acceptedPaymentMethods.includes(paymentMethod)
      )
        throw new Error("Escolha uma opção disponível.");
      const total =
        this.bag.subtotal()! +
        (fulfillment === "DELIVERY" ? settings.deliveryFeeCents : 0);
      const changeForCents =
        paymentMethod === "CASH" ? moneyInput(v.change) : null;
      this.quotedTerms = this.terms();
      await this.shop.model?.quote(
        {
          fulfillment,
          paymentMethod,
          addressId: v.addressId || null,
          notes: v.notes.trim() || null,
          changeForCents,
        },
        total,
      );
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : "Revise os dados do pedido.",
      );
    }
  }
  acknowledge() {
    if (
      window.confirm(
        "Você já conferiu o resultado com a pizzaria e quer liberar a sacola?",
      )
    )
      void this.shop.model?.acknowledgePending();
  }
}
