import { Location } from "@angular/common";
import { Component, inject, OnDestroy, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { ActivatedRoute, Router, RouterLink } from "@angular/router";
import { apiErrorCode, errorMessage } from "../core/api";
import { PendingTeamInvite } from "../core/pending-invite";
import { ROLE_LABELS, Session } from "../core/session";
import { type InvitePreview, type RedeemedInvite, TeamApi } from "./team-api";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const INVALID = "Este convite é inválido, já foi usado ou expirou.";

/**
 * Accepting a team invitation (M3.6, ADR 0015). The token leaves the address bar at once and
 * stays in memory only. A new person creates an account. A person who already has one signs in
 * (lockout and second factor included) and accepts with that session: the token waits in memory
 * during the sign-in, which brings them back here.
 */
@Component({
  selector: "wo-team-invite-page",
  imports: [FormsModule, RouterLink],
  template: `
    <a class="skip-link" href="#conteudo">Pular para o conteúdo</a>
    <main id="conteudo" class="card invite-card" tabindex="-1">
      <p class="brand">WhiteOven</p>
      <h1 tabindex="-1" data-page-title>Convite para a equipe</h1>

      @if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }

      @if (done(); as result) {
        <p role="status">
          Pronto! Você agora faz parte da equipe de {{ result.storeName }} como
          {{ labels[result.role] }}.
          @if (result.newAccount) {
            Entre com seu e-mail e a senha que você acabou de criar.
          }
        </p>
        <a class="button" [routerLink]="result.newAccount ? '/' : '/lojas'"
          >Ir para o painel</a
        >
      } @else if (loading()) {
        <p role="status">Conferindo convite…</p>
      } @else if (preview(); as invite) {
        <p>
          <strong>{{ invite.storeName }}</strong> convidou
          <strong>{{ invite.email }}</strong> para a equipe como
          <strong>{{ labels[invite.role] }}</strong
          >.
        </p>
        @if (invite.accountExists) {
          <p class="muted">
            Este e-mail já tem acesso ao WhiteOven. Para aceitar, entre com a
            conta {{ invite.email }}.
          </p>
          @if (signedIn()) {
            <button
              class="button"
              type="button"
              [disabled]="submitting()"
              (click)="accept()"
            >
              {{ submitting() ? "Entrando na equipe…" : "Aceitar convite" }}
            </button>
          } @else {
            <button class="button" type="button" (click)="signInToAccept()">
              Entrar para aceitar
            </button>
          }
        } @else {
          <form (submit)="$event.preventDefault(); submit()">
            <label for="invite-name">Seu nome</label>
            <input
              id="invite-name"
              name="name"
              autocomplete="name"
              maxlength="120"
              required
              [(ngModel)]="name"
            />
            <label for="invite-password">Crie uma senha</label>
            <input
              id="invite-password"
              name="password"
              type="password"
              autocomplete="new-password"
              minlength="10"
              maxlength="256"
              required
              aria-describedby="invite-password-hint"
              [(ngModel)]="password"
            />
            <small id="invite-password-hint">
              Use pelo menos 10 caracteres e evite senhas comuns.
            </small>
            <label for="invite-password-confirm">Repita a senha</label>
            <input
              id="invite-password-confirm"
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
              {{ submitting() ? "Entrando na equipe…" : "Aceitar convite" }}
            </button>
          </form>
        }
        <p class="expiry-note">Este convite só pode ser usado uma vez.</p>
      }
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
      margin-top: var(--wo-spacing-3);
    }
    .match-error {
      margin: 0;
      color: var(--wo-color-error);
    }
    .expiry-note {
      margin-top: var(--wo-spacing-4);
      font-size: var(--wo-fontSize-small);
    }
  `,
})
export class TeamInvitePage implements OnDestroy {
  private readonly api = inject(TeamApi);
  private readonly router = inject(Router);
  private readonly pending = inject(PendingTeamInvite);
  private inviteToken: string | null = null;
  protected readonly signedIn = inject(Session).signedIn;
  protected readonly labels = ROLE_LABELS;

  protected name = "";
  protected password = "";
  protected passwordConfirmation = "";
  protected readonly loading = signal(true);
  protected readonly preview = signal<InvitePreview | null>(null);
  protected readonly done = signal<RedeemedInvite | null>(null);
  protected readonly error = signal("");
  protected readonly submitting = signal(false);

  constructor() {
    // From the link, or back from the sign-in this page sent the person to.
    const token =
      inject(ActivatedRoute).snapshot.paramMap.get("token") ??
      this.pending.take();
    inject(Location).replaceState("/equipe/convite/aceitar");
    if (!token || !TOKEN.test(token)) {
      this.loading.set(false);
      this.error.set(
        token
          ? INVALID
          : "O link não contém um convite. Abra novamente o link recebido.",
      );
      return;
    }
    this.inviteToken = token;
    void this.load(token);
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
    if (!this.name.trim()) {
      this.error.set("Informe o seu nome.");
      return;
    }
    if (this.password !== this.passwordConfirmation) {
      this.error.set("As senhas não coincidem.");
      return;
    }
    await this.finish((token) =>
      this.api.redeem(token, this.name.trim(), this.password),
    );
  }

  protected async accept(): Promise<void> {
    await this.finish((token) => this.api.accept(token));
  }

  /** Keeps the token in memory through the sign-in, which comes back to this page. */
  protected async signInToAccept(): Promise<void> {
    const token = this.inviteToken;
    if (!token) return;
    this.pending.hold(token);
    this.inviteToken = null;
    await this.router.navigateByUrl("/entrar");
  }

  private async finish(
    request: (token: string) => Promise<RedeemedInvite>,
  ): Promise<void> {
    const token = this.inviteToken;
    if (!this.preview() || !token || this.submitting()) return;
    this.error.set("");
    this.submitting.set(true);
    try {
      const result = await request(token);
      this.inviteToken = null;
      this.name = "";
      this.password = "";
      this.passwordConfirmation = "";
      this.done.set(result);
    } catch (error) {
      const code = apiErrorCode(error);
      if (code === "INVITE_INVALID") {
        this.inviteToken = null;
        this.preview.set(null);
        this.error.set(INVALID);
      } else if (code === "VALIDATION_FAILED")
        this.error.set(
          "Confira o nome e use uma senha com pelo menos 10 caracteres, evitando senhas comuns.",
        );
      else this.error.set(errorMessage(error));
    } finally {
      this.submitting.set(false);
    }
  }

  private async load(token: string): Promise<void> {
    try {
      this.preview.set(await this.api.preview(token));
    } catch (error) {
      this.inviteToken = null;
      this.error.set(
        apiErrorCode(error) === "INVITE_INVALID"
          ? INVALID
          : errorMessage(error),
      );
    } finally {
      this.loading.set(false);
    }
  }
}
