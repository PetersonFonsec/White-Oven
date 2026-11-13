import {
  ChangeDetectionStrategy,
  Component,
  inject,
  signal,
} from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import type { Address } from "@whiteoven/customer-core/customer/client";
import { Shop } from "../../core/commerce/shop";
import { Button, Input } from "../../design-system/primitives";
@Component({
  selector: "wo-addresses",
  imports: [ReactiveFormsModule, Button, Input],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ` <h2>Endereços</h2>
    @for (address of shop.state()?.addresses; track address.id) {
      <article class="list-row">
        <div>
          <h3>{{ address.label }}</h3>
          <p>
            {{ address.street }}, {{ address.number }} · {{ address.city }}/{{
              address.state
            }}
          </p>
        </div>
        <button (click)="edit(address)">Editar {{ address.label }}</button
        ><button (click)="remove(address)">Excluir {{ address.label }}</button>
      </article>
    }
    @if (!editing()) {
      <button woButton variant="secondary" (click)="edit()">
        Novo endereço
      </button>
    } @else {
      <form [formGroup]="form" (ngSubmit)="save()">
        <h3>{{ id ? "Editar endereço" : "Novo endereço" }}</h3>
        <div class="form-grid">
          @for (field of fields; track field.key) {
            <label
              >{{ field.label
              }}<input
                woInput
                [formControlName]="field.key"
                [attr.aria-invalid]="
                  form.controls[field.key].touched &&
                  form.controls[field.key].invalid
                "
            /></label>
          }
        </div>
        @if (form.touched && form.invalid) {
          <p role="alert">
            Preencha os campos obrigatórios, o CEP com oito números e a UF com
            duas letras.
          </p>
        }
        <button woButton [disabled]="shop.state()?.busy">Salvar endereço</button
        ><button type="button" (click)="editing.set(false)">Cancelar</button>
      </form>
    }`,
})
export class Addresses {
  readonly shop = inject(Shop);
  readonly editing = signal(false);
  id?: string;
  readonly fields = [
    { key: "label", label: "Nome do endereço" },
    { key: "postalCode", label: "CEP" },
    { key: "street", label: "Rua" },
    { key: "number", label: "Número" },
    { key: "complement", label: "Complemento (opcional)" },
    { key: "district", label: "Bairro" },
    { key: "city", label: "Cidade" },
    { key: "state", label: "UF" },
    { key: "reference", label: "Referência (opcional)" },
  ] as const;
  readonly form = inject(FormBuilder).nonNullable.group({
    label: ["", Validators.required],
    postalCode: [
      "",
      [Validators.required, Validators.pattern(/^\d{5}-?\d{3}$/)],
    ],
    street: ["", Validators.required],
    number: ["", Validators.required],
    complement: "",
    district: ["", Validators.required],
    city: ["", Validators.required],
    state: ["", [Validators.required, Validators.pattern(/^[a-z]{2}$/i)]],
    reference: "",
  });
  edit(address?: Address) {
    this.id = address?.id;
    this.form.reset();
    if (address)
      this.form.patchValue({
        ...address,
        reference: address.reference ?? "",
        complement: address.complement ?? "",
      });
    this.editing.set(true);
  }
  async save() {
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const v = this.form.getRawValue();
    if (
      await this.shop.model?.saveAddress(
        {
          ...v,
          state: v.state.toUpperCase(),
          complement: v.complement || null,
          reference: v.reference || null,
        },
        this.id,
      )
    )
      this.editing.set(false);
  }
  remove(address: Address) {
    if (window.confirm("Excluir este endereço da sua conta?"))
      void this.shop.model?.removeAddress(address.id);
  }
}
