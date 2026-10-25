import { Location } from "@angular/common";
import { Component, inject, OnDestroy, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { errorMessage } from "../core/api";
import { PlatformApi } from "./platform-api";

@Component({
  selector: "wo-invite-redemption-page",
  imports: [FormsModule],
  template: `
    <a class="skip-link" href="#conteudo">Pular para o conteúdo</a>
    <main id="conteudo" class="card invite-card" tabindex="-1">
      <p class="brand">WhiteOven</p>
      <h1 tabindex="-1" data-page-title>Aceitar convite</h1>
      <p class="muted">Crie seu acesso de dono para administrar a pizzaria.</p>
      @if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }
      <form (ngSubmit)="submit()">
        <label for="owner-name">Seu nome</label>
        <input
          id="owner-name"
          name="name"
          autocomplete="name"
          maxlength="120"
          required
          [(ngModel)]="name"
        />
        <label for="owner-password">Crie uma senha</label>
        <input
          id="owner-password"
          name="password"
          type="password"
          autocomplete="new-password"
          minlength="10"
          maxlength="256"
          required
          [(ngModel)]="password"
          aria-describedby="password-hint"
        />
        <small id="password-hint">
          Use pelo menos 10 caracteres e evite senhas comuns.
        </small>
        <label for="owner-password-confirm">Repita a senha</label>
        <input
          id="owner-password-confirm"
          name="passwordConfirmation"
          type="password"
          autocomplete="new-password"
          minlength="10"
          maxlength="256"
          required
          [(ngModel)]="passwordConfirmation"
        />
        <p class="match-error" role="alert" [hidden]="!passwordMismatch()">
          As senhas não coincidem.
        </p>
        <button class="button" type="submit" [disabled]="submitting()">
          {{ submitting() ? "Criando acesso…" : "Criar acesso de dono" }}
        </button>
        <button
          class="button button--cancel"
          type="button"
          [disabled]="submitting()"
          (click)="cancel()"
        >
          Cancelar
        </button>
      </form>
      <p class="expiry-note">Este convite só pode ser usado uma vez.</p>
    </main>
  `,
  styles: `
    .invite-card {
      width: min(440px, calc(100% - 32px));
    }
    .invite-card h1 {
      margin-top: var(--wo-spacing-4);
    }
    form {
      display: grid;
      gap: var(--wo-spacing-2);
    }
    label {
      margin-top: var(--wo-spacing-2);
      font-weight: var(--wo-fontWeight-bold);
    }
    input {
      min-height: var(--wo-interaction-minimumTarget);
      padding: 0 var(--wo-spacing-3);
      border: 1px solid var(--wo-color-inputBorder);
      border-radius: var(--wo-radius-small);
      background: var(--wo-color-surface);
      color: var(--wo-color-text);
      font: inherit;
    }
    input:focus {
      outline: 3px solid var(--wo-color-focus);
      outline-offset: 2px;
    }
    small,
    .expiry-note {
      color: var(--wo-color-muted);
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: var(--wo-interaction-minimumTarget);
      margin-top: var(--wo-spacing-3);
      padding: 0 var(--wo-spacing-4);
      border: 0;
      border-radius: var(--wo-radius-small);
      background: var(--wo-color-primary);
      color: var(--wo-color-onPrimary);
      font: inherit;
      font-weight: var(--wo-fontWeight-bold);
      text-decoration: none;
      cursor: pointer;
    }
    .button:disabled {
      opacity: 0.65;
      cursor: wait;
    }
    .button--cancel {
      margin-top: 0;
      background: transparent;
      color: var(--wo-color-text);
      text-decoration: underline;
    }
    .match-error {
      margin: 0;
      color: var(--wo-color-error);
    }
    .status--error {
      padding: var(--wo-spacing-3) var(--wo-spacing-4);
      border-radius: var(--wo-radius-small);
      background: var(--wo-color-errorSurface);
      color: var(--wo-color-error);
    }
    .expiry-note {
      margin-top: var(--wo-spacing-4);
      font-size: var(--wo-fontSize-small);
    }
  `,
})
export class InviteRedemptionPage implements OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly api = inject(PlatformApi);
  private inviteToken: string | null = null;

  protected name = "";
  protected password = "";
  protected passwordConfirmation = "";
  protected readonly error = signal("");
  protected readonly submitting = signal(false);

  constructor() {
    const token = this.route.snapshot.paramMap.get("token");
    if (!token) {
      this.error.set(
        "O link não contém um convite. Abra novamente o link original recebido.",
      );
      return;
    }
    this.location.replaceState("/invite/aceitar");
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
      this.error.set("Este convite é inválido ou expirou.");
      return;
    }
    this.inviteToken = token;
  }

  ngOnDestroy(): void {
    this.inviteToken = null;
  }

  protected passwordMismatch(): boolean {
    return (
      this.passwordConfirmation.length > 0 &&
      this.password !== this.passwordConfirmation
    );
  }

  protected async submit(): Promise<void> {
    this.error.set("");
    if (this.passwordMismatch()) return;
    const token = this.inviteToken;
    if (!token) {
      this.error.set("Este convite é inválido ou expirou.");
      return;
    }
    this.submitting.set(true);
    try {
      await this.api.redeemInvite(token, this.name.trim(), this.password);
      this.inviteToken = null;
      this.name = "";
      this.password = "";
      this.passwordConfirmation = "";
      await this.router.navigateByUrl("/invite/concluido", {
        replaceUrl: true,
      });
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }

  protected async cancel(): Promise<void> {
    this.inviteToken = null;
    await this.router.navigateByUrl("/entrar", { replaceUrl: true });
  }
}

@Component({
  selector: "wo-invite-complete-page",
  imports: [RouterLink],
  template: `
    <main class="card invite-card" tabindex="-1">
      <p class="brand">WhiteOven</p>
      <h1 tabindex="-1" data-page-title>Conta criada</h1>
      <p role="status">
        Seu acesso de dono está pronto. Entre com seu e-mail e a senha que você
        acabou de cadastrar.
      </p>
      <a class="button" routerLink="/entrar">Entrar no painel</a>
    </main>
  `,
  styles: `
    .invite-card {
      width: min(440px, calc(100% - 32px));
    }
    .invite-card h1 {
      margin-top: var(--wo-spacing-4);
    }
    .button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: var(--wo-interaction-minimumTarget);
      margin-top: var(--wo-spacing-3);
      padding: 0 var(--wo-spacing-4);
      border: 0;
      border-radius: var(--wo-radius-small);
      background: var(--wo-color-primary);
      color: var(--wo-color-onPrimary);
      font: inherit;
      font-weight: var(--wo-fontWeight-bold);
      text-decoration: none;
    }
  `,
})
export class InviteCompletePage {}
