import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from "@angular/forms";
import { Router } from "@angular/router";
import { NgStyle } from "@angular/common";
import { Button, Input } from "../design-system/primitives";
import { themeProperties } from "../design-system/theme";
@Component({
  imports: [ReactiveFormsModule, NgStyle, Button, Input],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="entry" [ngStyle]="theme">
    <header class="entry-header">
      <a href="/" class="wordmark"
        >WhiteOven<span aria-hidden="true">.</span></a
      >
    </header>
    <main class="entry-main" id="conteudo">
      <section class="entry-copy">
        <h1>Sua pizzaria,<br />mais perto.</h1>
        <p>
          Abra o endereço da sua pizzaria para consultar as informações da loja.
        </p>
      </section>
      <section class="panel">
        <h2>Qual é a sua pizzaria?</h2>
        <p>Informe o identificador recebido da loja.</p>
        <form [formGroup]="form" (ngSubmit)="open()">
          <label for="slug">Identificador da pizzaria</label>
          <input
            woInput
            id="slug"
            formControlName="slug"
            autocomplete="off"
            autocapitalize="none"
            spellcheck="false"
            aria-describedby="slug-hint slug-error"
            [attr.aria-invalid]="invalid"
          />
          <p id="slug-hint" class="hint">
            De 3 a 40 caracteres: letras minúsculas, números ou hífens.
          </p>
          <p id="slug-error" class="error" role="alert">
            @if (invalid) {
              Confira o identificador enviado pela pizzaria.
            }
          </p>
          <button woButton type="submit">
            Abrir pizzaria <span aria-hidden="true">→</span>
          </button>
        </form>
      </section>
    </main>
    <footer class="entry-footer">
      Cada pizzaria tem seu próprio endereço.
    </footer>
  </div>`,
})
export class EntryPage {
  private readonly router = inject(Router);
  readonly theme = themeProperties();
  readonly form = new FormGroup({
    slug: new FormControl("", {
      nonNullable: true,
      validators: [
        Validators.required,
        Validators.pattern(/^[a-z0-9-]{3,40}$/),
      ],
    }),
  });
  get invalid(): boolean {
    return this.form.controls.slug.touched && this.form.controls.slug.invalid;
  }
  open(): void {
    this.form.markAllAsTouched();
    if (this.form.valid)
      void this.router.navigate(["/lojas", this.form.controls.slug.value]);
  }
}
