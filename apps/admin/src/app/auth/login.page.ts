import { DOCUMENT } from "@angular/common";
import { Component, inject, signal } from "@angular/core";
import { FormBuilder, ReactiveFormsModule, Validators } from "@angular/forms";
import { Router } from "@angular/router";
import { apiErrorCode, errorMessage } from "../core/api";
import { Session } from "../core/session";

/** E-mail and password, then the second factor when the account has one. */
@Component({
  selector: "wo-login-page",
  imports: [ReactiveFormsModule],
  template: `
    <main class="card">
      <p class="brand">WhiteOven</p>
      @if (mfaToken() === null) {
        <h1 tabindex="-1" data-page-title>Entrar no painel</h1>
        @if (session.logoutUnconfirmed()) {
          <p
            class="status--warning"
            role="status"
            data-testid="logout-unconfirmed"
          >
            Você saiu do painel neste navegador, mas não conseguimos confirmar
            com o servidor que a sessão foi encerrada. Ela não será retomada
            automaticamente aqui e vamos tentar encerrá-la de novo na próxima
            vez que o painel abrir. Se usou um computador compartilhado, tente
            de novo quando a conexão voltar.
          </p>
          <p>
            <button
              class="button button--secondary"
              type="button"
              [disabled]="busy()"
              (click)="retryLogout()"
            >
              Tentar encerrar a sessão de novo
            </button>
          </p>
        }
        <form [formGroup]="credentials" (ngSubmit)="signIn()" novalidate>
          <div class="field">
            <label for="email">E-mail</label>
            <input
              id="email"
              type="email"
              formControlName="email"
              autocomplete="username"
              required
            />
          </div>
          <div class="field">
            <label for="password">Senha</label>
            <input
              id="password"
              type="password"
              formControlName="password"
              autocomplete="current-password"
              required
            />
          </div>
          @if (error()) {
            <p class="status--error" role="alert">{{ error() }}</p>
          }
          <button class="button" type="submit" [disabled]="busy()">
            {{ busy() ? "Entrando…" : "Entrar" }}
          </button>
        </form>
      } @else {
        <h1 tabindex="-1" data-page-title>Verificação em duas etapas</h1>
        <form [formGroup]="factor" (ngSubmit)="verify()" novalidate>
          <div class="field">
            @if (useRecovery()) {
              <label for="factor">Código de recuperação</label>
              <input
                id="factor"
                formControlName="value"
                autocomplete="off"
                required
              />
            } @else {
              <label for="factor">Código do aplicativo autenticador</label>
              <input
                id="factor"
                formControlName="value"
                inputmode="numeric"
                autocomplete="one-time-code"
                required
              />
            }
          </div>
          @if (error()) {
            <p class="status--error" role="alert">{{ error() }}</p>
          }
          <button class="button" type="submit" [disabled]="busy()">
            {{ busy() ? "Verificando…" : "Verificar" }}
          </button>
          <p>
            <button
              class="button--link"
              type="button"
              (click)="toggleRecovery()"
            >
              {{
                useRecovery()
                  ? "Usar o código do aplicativo"
                  : "Usar um código de recuperação"
              }}
            </button>
          </p>
        </form>
      }
    </main>
  `,
})
export class LoginPage {
  protected readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly forms = inject(FormBuilder).nonNullable;

  protected readonly credentials = this.forms.group({
    email: ["", [Validators.required, Validators.email]],
    password: ["", Validators.required],
  });
  protected readonly factor = this.forms.group({
    value: ["", Validators.required],
  });
  protected readonly mfaToken = signal<string | null>(null);
  protected readonly useRecovery = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected async retryLogout(): Promise<void> {
    await this.run(async () => {
      if ((await this.session.retryLogout()) === "unconfirmed")
        this.error.set(
          "Ainda não foi possível falar com o servidor. Tente de novo em instantes.",
        );
    });
  }

  protected async signIn(): Promise<void> {
    if (this.credentials.invalid) {
      this.error.set("Informe e-mail e senha.");
      return;
    }
    const { email, password } = this.credentials.getRawValue();
    await this.run(async () => {
      const result = await this.session.login(email.trim(), password);
      if (result === "signed-in") await this.router.navigateByUrl("/");
      else {
        this.credentials.reset();
        this.mfaToken.set(result.mfaToken);
        this.focusTitle();
      }
    });
  }

  protected async verify(): Promise<void> {
    const value = this.factor.getRawValue().value.trim();
    if (!value) {
      this.error.set("Informe o código.");
      return;
    }
    await this.run(async () => {
      await this.session.loginMfa(
        this.mfaToken()!,
        this.useRecovery() ? { recoveryCode: value } : { code: value },
      );
      await this.router.navigateByUrl("/");
    });
  }

  protected toggleRecovery(): void {
    this.useRecovery.update((value) => !value);
    this.factor.reset();
    this.error.set(null);
  }

  private async run(work: () => Promise<void>): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await work();
    } catch (error) {
      this.error.set(errorMessage(error));
      // An expired or exhausted challenge cannot be retried: back to the password.
      if (apiErrorCode(error) === "MFA_CHALLENGE_INVALID")
        this.mfaToken.set(null);
    } finally {
      this.busy.set(false);
    }
  }

  private focusTitle(): void {
    setTimeout(() =>
      this.document.querySelector<HTMLElement>("[data-page-title]")?.focus(),
    );
  }
}
