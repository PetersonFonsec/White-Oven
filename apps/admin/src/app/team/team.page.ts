import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { apiFieldErrors, errorMessage } from "../core/api";
import { ROLE_LABELS, type Role } from "../core/session";
import {
  type CreatedInvite,
  TEAM_ROLES,
  type Team,
  type TeamMember,
  TeamApi,
} from "./team-api";

const dateTime = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
});
const date = new Intl.DateTimeFormat("pt-BR", { dateStyle: "short" });

/**
 * Team of the store for the OWNER (M3.6, ADR 0015): invite by link, change roles, revoke access.
 * The API keeps the last OWNER and ends a revoked person's sessions; the page only explains it.
 */
@Component({
  selector: "wo-team-page",
  imports: [FormsModule],
  styleUrl: "./team.page.css",
  template: `
    <section aria-labelledby="team-title">
      <h1 id="team-title" tabindex="-1" data-page-title>Equipe</h1>
      <p class="muted">
        Quem pode entrar no painel desta loja e com qual papel. A loja sempre
        mantém pelo menos um dono.
      </p>

      @if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p class="team-notice" role="status">{{ notice() }}</p>
      }

      <section class="team-block" aria-labelledby="invite-title">
        <h2 id="invite-title">Convidar pessoa</h2>
        <form class="invite-form" (submit)="$event.preventDefault(); invite()">
          <div class="field">
            <label for="invite-email">E-mail</label>
            <input
              id="invite-email"
              name="email"
              type="email"
              autocomplete="off"
              maxlength="254"
              required
              [attr.aria-invalid]="emailError() ? true : null"
              [attr.aria-describedby]="
                emailError() ? 'invite-email-error' : null
              "
              [(ngModel)]="email"
            />
            @if (emailError()) {
              <p id="invite-email-error" class="field-error">
                {{ emailError() }}
              </p>
            }
          </div>
          <div class="field">
            <label for="invite-role">Papel</label>
            <select id="invite-role" name="role" [(ngModel)]="role">
              @for (option of roles; track option) {
                <option [value]="option">{{ labels[option] }}</option>
              }
            </select>
          </div>
          <button class="button" type="submit" [disabled]="busy()">
            {{ busy() === "invite" ? "Gerando convite…" : "Gerar convite" }}
          </button>
        </form>
        <p class="muted role-help">
          Dono administra tudo, inclusive a equipe. Gerente mantém o cardápio e
          os pedidos. Equipe atende os pedidos.
        </p>

        @if (created(); as invite) {
          <div class="invite-result" aria-labelledby="invite-result-title">
            <h3 id="invite-result-title">Convite pronto para compartilhar</h3>
            <p>
              Envie este link para {{ invite.invite.email }}. Ele pode ser usado
              uma vez, expira em {{ invite.expiresIn / 3600 }} horas e só
              aparece agora.
            </p>
            <label for="invite-link">Link de convite</label>
            <div class="invite-link-row">
              <input id="invite-link" readonly [value]="invite.inviteUrl" />
              <button
                class="button button--secondary"
                type="button"
                (click)="copy(invite)"
              >
                {{ copied() ? "Copiado" : "Copiar link" }}
              </button>
            </div>
          </div>
        }
      </section>

      @if (loading()) {
        <p role="status">Carregando equipe…</p>
      }

      @if (team(); as current) {
        <section class="team-block" aria-labelledby="members-title">
          <h2 id="members-title">Pessoas com acesso</h2>
          <ul class="team-list">
            @for (member of current.members; track member.membershipId) {
              <li class="team-row" [attr.aria-label]="member.name">
                <div class="team-person">
                  <strong>{{ member.name }}</strong>
                  @if (member.you) {
                    <span class="team-you">Você</span>
                  }
                  <span class="muted">{{ member.email }}</span>
                  <span class="muted"
                    >Desde {{ sinceLabel(member.since) }}</span
                  >
                </div>
                @if (member.you) {
                  <p class="team-role">
                    {{ labels[member.role] }}
                    <span class="muted"
                      >Outro dono pode alterar o seu papel.</span
                    >
                  </p>
                } @else {
                  <div class="team-actions">
                    <label
                      class="visually-hidden"
                      [for]="'role-' + member.membershipId"
                      >Papel de {{ member.name }}</label
                    >
                    <select
                      [id]="'role-' + member.membershipId"
                      [name]="'role-' + member.membershipId"
                      [ngModel]="draftOf(member)"
                      (ngModelChange)="draftRole(member, $event)"
                    >
                      @for (option of roles; track option) {
                        <option [value]="option">{{ labels[option] }}</option>
                      }
                    </select>
                    <button
                      class="button button--secondary"
                      type="button"
                      [disabled]="busy() || draftOf(member) === member.role"
                      (click)="changeRole(member)"
                    >
                      Alterar papel
                    </button>
                    <button
                      class="button button--danger"
                      type="button"
                      [disabled]="busy()"
                      (click)="revoke(member)"
                    >
                      Revogar acesso
                    </button>
                  </div>
                }
              </li>
            }
          </ul>
        </section>

        <section class="team-block" aria-labelledby="pending-title">
          <h2 id="pending-title">Convites pendentes</h2>
          @if (current.invites.length === 0) {
            <p class="muted">Nenhum convite aguardando resposta.</p>
          } @else {
            <ul class="team-list">
              @for (invite of current.invites; track invite.id) {
                <li class="team-row" [attr.aria-label]="invite.email">
                  <div class="team-person">
                    <strong>{{ invite.email }}</strong>
                    <span class="muted"
                      >{{ labels[invite.role] }} · expira em
                      {{ expiryLabel(invite.expiresAt) }}</span
                    >
                  </div>
                  <div class="team-actions">
                    <button
                      class="button button--secondary"
                      type="button"
                      [disabled]="busy()"
                      (click)="cancelInvite(invite.id, invite.email)"
                    >
                      Cancelar convite
                    </button>
                  </div>
                </li>
              }
            </ul>
          }
        </section>
      }
    </section>
  `,
})
export class TeamPage {
  private readonly api = inject(TeamApi);
  protected readonly roles = TEAM_ROLES;
  protected readonly labels = ROLE_LABELS;

  protected email = "";
  protected role: Role = "STAFF";
  protected readonly team = signal<Team | null>(null);
  protected readonly loading = signal(true);
  /** The action running, so the buttons wait for it. */
  protected readonly busy = signal<string | null>(null);
  protected readonly error = signal("");
  protected readonly notice = signal("");
  protected readonly emailError = signal("");
  protected readonly created = signal<CreatedInvite | null>(null);
  protected readonly copied = signal(false);
  protected readonly roleDrafts = signal<Partial<Record<string, Role>>>({});
  /** Kept while the same invite is retried, so a lost response does not replace the link. */
  private idempotencyKey = "";
  private requestBody = "";

  constructor() {
    void this.load();
  }

  protected sinceLabel(iso: string): string {
    return date.format(new Date(iso));
  }

  protected expiryLabel(iso: string): string {
    return dateTime.format(new Date(iso));
  }

  /** The role chosen in the row's select, before "Alterar papel". */
  protected draftOf(member: TeamMember): Role {
    return this.roleDrafts()[member.membershipId] ?? member.role;
  }

  protected draftRole(member: TeamMember, role: Role): void {
    this.roleDrafts.update((drafts) => ({
      ...drafts,
      [member.membershipId]: role,
    }));
  }

  protected async invite(): Promise<void> {
    if (this.busy()) return;
    this.emailError.set("");
    const email = this.email.trim();
    if (!email) {
      this.emailError.set("Informe o e-mail da pessoa.");
      return;
    }
    await this.run("invite", async () => {
      this.created.set(null);
      this.copied.set(false);
      try {
        const body = JSON.stringify({ email, role: this.role });
        if (body !== this.requestBody) {
          this.requestBody = body;
          this.idempotencyKey = crypto.randomUUID();
        }
        const invite = await this.api.invite(
          email,
          this.role,
          this.idempotencyKey,
        );
        this.created.set(invite);
        this.requestBody = "";
        this.idempotencyKey = "";
        this.email = "";
        this.role = "STAFF";
        this.notice.set(
          `Convite criado para ${invite.invite.email} como ${this.labels[invite.invite.role]}.`,
        );
      } catch (error) {
        if (apiFieldErrors(error).some((e) => e.path === "email")) {
          this.emailError.set("Use um e-mail válido, como nome@exemplo.com.");
          return;
        }
        throw error;
      }
    });
  }

  protected async copy(invite: CreatedInvite): Promise<void> {
    this.error.set("");
    this.copied.set(false);
    try {
      await navigator.clipboard.writeText(invite.inviteUrl);
      this.copied.set(true);
    } catch {
      this.error.set(
        "Não foi possível copiar automaticamente. Selecione e copie o link exibido.",
      );
    }
  }

  protected async changeRole(member: TeamMember): Promise<void> {
    const role = this.draftOf(member);
    if (role === member.role || this.busy()) return;
    await this.run(member.membershipId, async () => {
      await this.api.changeRole(member.membershipId, role);
      this.notice.set(
        `${member.name} agora é ${this.labels[role]}. A mudança vale a partir da próxima ação da pessoa.`,
      );
    });
  }

  protected async revoke(member: TeamMember): Promise<void> {
    if (
      this.busy() ||
      !window.confirm(
        `Revogar o acesso de ${member.name} a esta loja? A pessoa sai do painel da loja na hora.`,
      )
    )
      return;
    await this.run(member.membershipId, async () => {
      await this.api.revoke(member.membershipId);
      this.notice.set(
        `Acesso de ${member.name} revogado. As sessões da pessoa nesta loja foram encerradas.`,
      );
    });
  }

  protected async cancelInvite(inviteId: string, email: string): Promise<void> {
    if (this.busy()) return;
    await this.run(inviteId, async () => {
      await this.api.cancelInvite(inviteId);
      if (this.created()?.invite.id === inviteId) this.created.set(null);
      this.notice.set(`Convite de ${email} cancelado. O link deixou de valer.`);
    });
  }

  /** Runs an action, shows its error, and reloads the team afterwards either way. */
  private async run(key: string, action: () => Promise<void>): Promise<void> {
    this.busy.set(key);
    this.error.set("");
    this.notice.set("");
    try {
      await action();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      await this.load();
      this.busy.set(null);
    }
  }

  private async load(): Promise<void> {
    try {
      this.team.set(await this.api.team());
      this.roleDrafts.set({});
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
  }
}
