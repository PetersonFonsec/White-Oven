import { Component, inject, signal } from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { Router } from "@angular/router";
import { errorMessage } from "../core/api";
import { type MfaSetup, Session } from "../core/session";

/**
 * First sign-in of a WhiteOven operator: the API accepts nothing else until the second factor is
 * enrolled (ADR 0007). Shows the secret once, confirms a first code and shows the recovery codes
 * once.
 */
@Component({
  selector: "wo-mfa-setup-page",
  imports: [ReactiveFormsModule],
  template: `
    <main class="card">
      <p class="brand">WhiteOven</p>
      <h1 tabindex="-1" data-page-title>Ative a verificação em duas etapas</h1>
      @if (recoveryCodes(); as codes) {
        <p>
          Guarde estes códigos de recuperação em um lugar seguro. Cada um vale
          uma vez e eles não serão mostrados de novo.
        </p>
        <ul class="code" data-testid="recovery-codes">
          @for (code of codes; track code) {
            <li>{{ code }}</li>
          }
        </ul>
        <button class="button" type="button" (click)="finish()">
          Já guardei os códigos
        </button>
      } @else if (setup(); as secret) {
        <p>
          No aplicativo autenticador, adicione uma conta com a chave abaixo (ou
          abra o link de configuração) e informe o código de 6 dígitos.
        </p>
        <p>
          Chave:
          <span class="code" data-testid="mfa-secret">{{ secret.secret }}</span>
        </p>
        <p>
          <a [href]="secret.otpauthUri">Abrir no aplicativo autenticador</a>
        </p>
        <form [formGroup]="form" (ngSubmit)="activate()" novalidate>
          <div class="field">
            <label for="code">Código de 6 dígitos</label>
            <input
              id="code"
              formControlName="code"
              inputmode="numeric"
              autocomplete="one-time-code"
              required
            />
          </div>
          @if (error()) {
            <p class="status--error" role="alert">{{ error() }}</p>
          }
          <button class="button" type="submit" [disabled]="busy()">
            Ativar
          </button>
        </form>
      } @else {
        <p>
          Contas de operador da plataforma precisam de um segundo fator antes de
          qualquer outra ação.
        </p>
        @if (error()) {
          <p class="status--error" role="alert">{{ error() }}</p>
        }
        <button
          class="button"
          type="button"
          (click)="start()"
          [disabled]="busy()"
        >
          Gerar chave
        </button>
      }
      <p>
        <button class="button--link" type="button" (click)="logout()">
          Sair
        </button>
      </p>
    </main>
  `,
})
export class MfaSetupPage {
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  protected readonly form = inject(FormBuilder).nonNullable.group({
    code: ["", Validators.required],
  });
  protected readonly setup = signal<MfaSetup | null>(null);
  protected readonly recoveryCodes = signal<string[] | null>(null);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async start(): Promise<void> {
    await this.run(async () => this.setup.set(await this.session.setupMfa()));
  }

  protected async activate(): Promise<void> {
    const code = this.form.getRawValue().code.trim();
    if (!code) {
      this.error.set("Informe o código.");
      return;
    }
    await this.run(async () =>
      this.recoveryCodes.set(await this.session.activateMfa(code)),
    );
  }

  protected async finish(): Promise<void> {
    await this.router.navigateByUrl("/");
  }

  protected async logout(): Promise<void> {
    // Ends the session here at once; the revocation finishes in the background (Session.logout).
    void this.session.logout();
    await this.router.navigateByUrl("/entrar");
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }
}
