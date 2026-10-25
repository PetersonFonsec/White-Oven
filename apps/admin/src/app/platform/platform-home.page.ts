import {
  Component,
  ElementRef,
  ViewChild,
  computed,
  inject,
  signal,
} from "@angular/core";
import { FormsModule, NgForm } from "@angular/forms";
import { Router, RouterLink } from "@angular/router";
import { errorMessage } from "../core/api";
import { Session } from "../core/session";
import {
  PlatformApi,
  type PlatformTenant,
  type OwnerInvite,
} from "./platform-api";

type TenantInput = { slug: string; displayName: string; ownerEmail: string };

/** Tenant lifecycle controls for authenticated, MFA-verified platform operators. */
@Component({
  selector: "wo-platform-home-page",
  imports: [FormsModule, RouterLink],
  template: `
    <a class="skip-link" href="#conteudo">Pular para o conteúdo</a>
    <header class="topbar">
      <span class="brand">WhiteOven · Plataforma</span>
      <span class="actions">
        <a routerLink="/lojas" [queryParams]="{ trocar: 1 }">Abrir uma loja</a>
        <button class="button--link" type="button" (click)="logout()">
          Sair
        </button>
      </span>
    </header>

    <main id="conteudo" class="platform" tabindex="-1">
      <div class="page-heading">
        <div>
          <p class="eyebrow">WhiteOven · Operações</p>
          <h1 tabindex="-1" data-page-title>Área de plataforma</h1>
          <p class="muted">
            Cadastre pizzarias, acompanhe o acesso e cuide do ciclo de cada
            loja.
          </p>
        </div>
        <span class="operator-badge">Operador verificado</span>
      </div>

      @if (error() && !pendingChange()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }
      @if (notice()) {
        <p class="status--success" role="status">{{ notice() }}</p>
      }

      <section class="panel" aria-labelledby="tenants-title">
        <div class="section-heading">
          <div>
            <h2 id="tenants-title">Pizzarias</h2>
            <p class="muted">{{ tenantCountLabel() }}</p>
          </div>
          <button
            class="button button--secondary"
            type="button"
            [disabled]="loading()"
            (click)="loadTenants()"
          >
            Atualizar lista
          </button>
        </div>

        @if (listError()) {
          <p class="status--error" role="alert">{{ listError() }}</p>
        }

        @if (loading()) {
          <p role="status">Carregando pizzarias…</p>
        } @else if (tenants().length === 0) {
          <div class="empty-state">
            <h3>Nenhuma pizzaria cadastrada</h3>
            <p class="muted">Cadastre a primeira loja para iniciar o acesso.</p>
          </div>
        } @else {
          <div class="table-scroll">
            <table>
              <caption class="visually-hidden">
                Pizzarias cadastradas na plataforma
              </caption>
              <thead>
                <tr>
                  <th scope="col">Pizzaria</th>
                  <th scope="col">Identificador</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Cadastro</th>
                  <th scope="col">
                    <span class="visually-hidden">Ações</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                @for (tenant of tenants(); track tenant.id) {
                  <tr>
                    <th scope="row">{{ tenant.displayName }}</th>
                    <td>
                      <code>{{ tenant.slug }}</code>
                    </td>
                    <td>
                      <span
                        class="status"
                        [class]="
                          'status status--' + tenant.status.toLowerCase()
                        "
                      >
                        {{ statusLabel(tenant.status) }}
                      </span>
                    </td>
                    <td>{{ dateLabel(tenant.createdAt) }}</td>
                    <td class="row-action">
                      @if (tenant.status === "SUSPENDED") {
                        <button
                          class="button button--secondary"
                          type="button"
                          [attr.aria-label]="'Reativar ' + tenant.displayName"
                          [disabled]="busyTenantId() === tenant.id"
                          (click)="askStatusChange(tenant, 'ACTIVE')"
                        >
                          Reativar
                        </button>
                      } @else {
                        <button
                          class="button button--danger"
                          type="button"
                          [attr.aria-label]="'Suspender ' + tenant.displayName"
                          [disabled]="busyTenantId() === tenant.id"
                          (click)="askStatusChange(tenant, 'SUSPENDED')"
                        >
                          Suspender
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>

      <section class="panel create-panel" aria-labelledby="create-title">
        <div class="section-heading">
          <div>
            <h2 id="create-title">Cadastrar pizzaria</h2>
            <p class="muted">
              O cadastro cria um convite de uso único para a pessoa responsável.
            </p>
          </div>
        </div>
        <form
          #tenantForm="ngForm"
          class="tenant-form"
          (ngSubmit)="createTenant()"
        >
          <label for="tenant-name">Nome da pizzaria</label>
          <input
            id="tenant-name"
            name="displayName"
            autocomplete="organization"
            maxlength="80"
            required
            [(ngModel)]="form.displayName"
          />

          <label for="tenant-slug">Identificador da loja</label>
          <input
            id="tenant-slug"
            name="slug"
            autocomplete="off"
            minlength="3"
            maxlength="40"
            pattern="[a-z0-9-]+"
            required
            [(ngModel)]="form.slug"
            aria-describedby="slug-hint"
          />
          <small id="slug-hint">Use letras minúsculas, números e hífens.</small>

          <label for="owner-email">E-mail da pessoa responsável</label>
          <input
            id="owner-email"
            name="ownerEmail"
            type="email"
            autocomplete="email"
            maxlength="254"
            required
            [(ngModel)]="form.ownerEmail"
          />

          <button class="button" type="submit" [disabled]="creating()">
            {{ creating() ? "Cadastrando…" : "Cadastrar e gerar convite" }}
          </button>
        </form>

        @if (invite(); as createdInvite) {
          <div
            class="invite-result"
            role="status"
            aria-labelledby="invite-title"
          >
            <h3 id="invite-title">Convite pronto para compartilhar</h3>
            <p>
              Ele pode ser usado uma vez e expira em
              {{ durationLabel(createdInvite.expiresIn) }}. Copie o link e envie
              à pessoa responsável.
            </p>
            <label for="invite-link">Link de convite</label>
            <div class="invite-link-row">
              <input
                id="invite-link"
                readonly
                [value]="createdInvite.inviteUrl"
              />
              <button
                class="button button--secondary"
                type="button"
                (click)="copyInvite(createdInvite)"
              >
                {{ copied() ? "Copiado" : "Copiar link" }}
              </button>
            </div>
          </div>
        }
      </section>
    </main>

    @if (pendingChange(); as change) {
      <dialog
        #confirmDialog
        class="confirm-dialog"
        role="alertdialog"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-description"
        (cancel)="onDialogCancel($event)"
      >
        <h2 #confirmTitle id="confirm-title" tabindex="-1">
          {{
            change.status === "SUSPENDED"
              ? "Suspender pizzaria?"
              : "Reativar pizzaria?"
          }}
        </h2>
        <p id="confirm-description">
          @if (change.status === "SUSPENDED") {
            A loja <strong>{{ change.tenant.displayName }}</strong> deixará de
            aceitar pedidos. Pedidos aguardando aceite serão recusados e as
            sessões de gerentes e equipe vinculadas a ela serão encerradas. O
            acesso de dono permanece.
          } @else {
            A loja <strong>{{ change.tenant.displayName }}</strong> poderá
            voltar a usar o painel e receber pedidos.
          }
        </p>
        @if (error()) {
          <p class="status--error" role="alert">{{ error() }}</p>
        }
        <div class="dialog-actions">
          <button
            class="button button--secondary"
            type="button"
            (click)="cancelStatusChange()"
          >
            Voltar
          </button>
          <button
            class="button"
            [class.button--danger]="change.status === 'SUSPENDED'"
            type="button"
            [disabled]="savingStatus()"
            (click)="confirmStatusChange()"
          >
            {{
              savingStatus()
                ? "Salvando…"
                : change.status === "SUSPENDED"
                  ? "Suspender pizzaria"
                  : "Reativar pizzaria"
            }}
          </button>
        </div>
      </dialog>
    }
  `,
  styles: `
    :host {
      display: block;
      min-height: 100vh;
      background: var(--wo-color-cream);
    }
    .topbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--wo-spacing-4);
      padding: var(--wo-spacing-3) var(--wo-spacing-5);
      background: var(--wo-color-surface);
      border-bottom: 1px solid var(--wo-color-border);
    }
    .brand {
      font-weight: var(--wo-fontWeight-bold);
    }
    .actions {
      display: flex;
      align-items: center;
      gap: var(--wo-spacing-4);
      margin-left: auto;
    }
    .platform {
      width: min(1120px, calc(100% - 2 * var(--wo-spacing-5)));
      margin: 0 auto;
      padding: var(--wo-spacing-7) 0 var(--wo-spacing-8);
    }
    .page-heading,
    .section-heading {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: var(--wo-spacing-4);
    }
    .page-heading {
      margin-bottom: var(--wo-spacing-6);
    }
    .page-heading h1 {
      margin: 0 0 var(--wo-spacing-2);
      font-size: clamp(1.8rem, 4vw, 2.5rem);
    }
    .page-heading p {
      margin-top: 0;
    }
    .eyebrow {
      color: var(--wo-color-accentText);
      font-size: var(--wo-fontSize-small);
      font-weight: var(--wo-fontWeight-bold);
    }
    .operator-badge {
      flex: none;
      padding: var(--wo-spacing-2) var(--wo-spacing-3);
      border-radius: 999px;
      background: var(--wo-color-orangeSoft);
      color: var(--wo-color-accentText);
      font-size: var(--wo-fontSize-small);
      font-weight: var(--wo-fontWeight-bold);
    }
    .panel {
      margin-bottom: var(--wo-spacing-5);
      padding: var(--wo-spacing-5);
      border: 1px solid var(--wo-color-border);
      border-radius: var(--wo-radius-card);
      background: var(--wo-color-surface);
      box-shadow: var(--wo-shadow-card);
    }
    .section-heading {
      align-items: center;
      margin-bottom: var(--wo-spacing-4);
    }
    h2 {
      margin: 0 0 var(--wo-spacing-1);
      font-size: 1.25rem;
    }
    .section-heading p {
      margin: 0;
    }
    .row-action {
      text-align: right;
      white-space: nowrap;
    }
    .status {
      display: inline-flex;
      align-items: center;
      min-height: 28px;
      padding: 0 var(--wo-spacing-2);
      border-radius: 999px;
      font-size: var(--wo-fontSize-small);
      font-weight: var(--wo-fontWeight-bold);
    }
    .status--active {
      background: #e8f4ea;
      color: #245a31;
    }
    .status--onboarding {
      background: var(--wo-color-orangeSoft);
      color: var(--wo-color-accentText);
    }
    .status--suspended {
      background: var(--wo-color-errorSurface);
      color: var(--wo-color-error);
    }
    .empty-state {
      padding: var(--wo-spacing-5);
      border: 1px dashed var(--wo-color-border);
      border-radius: var(--wo-radius-small);
    }
    .empty-state h3,
    .invite-result h3 {
      margin: 0 0 var(--wo-spacing-2);
    }
    .empty-state p {
      margin: 0;
    }
    .invite-result {
      display: grid;
      gap: var(--wo-spacing-2);
      max-width: 760px;
      margin-top: var(--wo-spacing-5);
      padding: var(--wo-spacing-4);
      border: 1px solid var(--wo-color-border);
      border-radius: var(--wo-radius-small);
      background: var(--wo-color-cream);
    }
    .invite-result p {
      margin: 0;
    }
    .invite-link-row {
      display: flex;
      gap: var(--wo-spacing-2);
    }
    .invite-link-row input {
      flex: 1;
      min-width: 0;
    }
    .confirm-dialog {
      width: min(520px, calc(100% - 32px));
      max-height: calc(100% - 32px);
      padding: var(--wo-spacing-5);
      border: 0;
      border-radius: var(--wo-radius-card);
      background: var(--wo-color-surface);
      color: var(--wo-color-text);
      box-shadow: 0 18px 56px rgb(0 0 0 / 0.2);
    }
    .confirm-dialog::backdrop {
      background: rgb(20 18 17 / 0.48);
    }
    .confirm-dialog h2 {
      margin-bottom: var(--wo-spacing-3);
    }
    .confirm-dialog p {
      line-height: 1.55;
    }
    .dialog-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: var(--wo-spacing-2);
      margin-top: var(--wo-spacing-5);
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    @media (max-width: 700px) {
      .platform {
        width: calc(100% - 2 * var(--wo-spacing-3));
        padding-top: var(--wo-spacing-5);
      }
      .panel {
        padding: var(--wo-spacing-3);
      }
      .page-heading {
        flex-direction: column;
      }
      .section-heading {
        align-items: flex-start;
      }
      .invite-link-row {
        flex-direction: column;
      }
      .invite-link-row .button {
        align-self: flex-start;
      }
      th,
      td {
        padding: var(--wo-spacing-2);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      * {
        transition: none !important;
      }
    }
  `,
})
export class PlatformHomePage {
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly api = inject(PlatformApi);

  protected readonly tenants = signal<PlatformTenant[]>([]);
  protected readonly loading = signal(true);
  protected readonly creating = signal(false);
  protected readonly savingStatus = signal(false);
  protected readonly busyTenantId = signal<string | null>(null);
  protected readonly invite = signal<OwnerInvite | null>(null);
  protected readonly copied = signal(false);
  protected readonly error = signal("");
  protected readonly listError = signal("");
  protected readonly notice = signal("");
  protected readonly pendingChange = signal<{
    tenant: PlatformTenant;
    status: "ACTIVE" | "SUSPENDED";
  } | null>(null);
  protected readonly tenantCountLabel = computed(() => {
    const count = this.tenants().length;
    return `${count} ${count === 1 ? "pizzaria cadastrada" : "pizzarias cadastradas"}`;
  });
  protected form: TenantInput = { slug: "", displayName: "", ownerEmail: "" };

  private requestBody = "";
  private idempotencyKey = "";
  private listGeneration = 0;

  @ViewChild("confirmDialog")
  set confirmDialog(element: ElementRef<HTMLDialogElement> | undefined) {
    const dialog = element?.nativeElement;
    if (!dialog || dialog.open) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else {
      dialog.open = true;
      dialog.querySelector("button")?.focus();
    }
  }

  @ViewChild("tenantForm")
  private tenantForm?: NgForm;

  constructor() {
    void this.loadTenants();
  }

  protected async loadTenants(afterCreate = false): Promise<void> {
    const generation = ++this.listGeneration;
    this.loading.set(true);
    this.listError.set("");
    try {
      const tenants = await this.api.listTenants();
      if (generation !== this.listGeneration) return;
      this.tenants.set(tenants);
    } catch (error) {
      if (generation !== this.listGeneration) return;
      this.listError.set(
        afterCreate
          ? `Pizzaria cadastrada e convite criado, mas a lista não pôde ser atualizada. ${errorMessage(error)}`
          : errorMessage(error),
      );
    } finally {
      if (generation === this.listGeneration) this.loading.set(false);
    }
  }

  protected async createTenant(): Promise<void> {
    this.error.set("");
    this.notice.set("");
    this.invite.set(null);
    this.copied.set(false);
    const input: TenantInput = {
      slug: this.form.slug.trim(),
      displayName: this.form.displayName.trim(),
      ownerEmail: this.form.ownerEmail.trim(),
    };
    const serialized = JSON.stringify(input);
    if (serialized !== this.requestBody) {
      this.requestBody = serialized;
      this.idempotencyKey = crypto.randomUUID();
    }
    this.creating.set(true);
    try {
      const result = await this.api.createTenant(input, this.idempotencyKey);
      this.invite.set(result);
      this.notice.set("Pizzaria cadastrada e convite criado.");
      this.form = { slug: "", displayName: "", ownerEmail: "" };
      this.tenantForm?.resetForm(this.form);
      this.requestBody = "";
      this.idempotencyKey = "";
      await this.loadTenants(true);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.creating.set(false);
    }
  }

  protected askStatusChange(
    tenant: PlatformTenant,
    status: "ACTIVE" | "SUSPENDED",
  ): void {
    this.error.set("");
    this.pendingChange.set({ tenant, status });
  }

  protected cancelStatusChange(): void {
    if (!this.savingStatus()) this.pendingChange.set(null);
  }

  protected onDialogCancel(event: Event): void {
    event.preventDefault();
    this.cancelStatusChange();
  }

  protected async confirmStatusChange(): Promise<void> {
    const change = this.pendingChange();
    if (!change || this.savingStatus()) return;
    this.error.set("");
    this.notice.set("");
    this.savingStatus.set(true);
    this.busyTenantId.set(change.tenant.id);
    try {
      await this.api.changeStatus(change.tenant.id, change.status);
      this.pendingChange.set(null);
      this.notice.set(
        change.status === "SUSPENDED"
          ? "Pizzaria suspensa. Pedidos aguardando aceite foram recusados; sessões de gerentes e equipe vinculadas a ela foram encerradas."
          : "Pizzaria reativada.",
      );
      await this.loadTenants();
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.savingStatus.set(false);
      this.busyTenantId.set(null);
    }
  }

  protected async copyInvite(invite: OwnerInvite): Promise<void> {
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

  protected statusLabel(status: PlatformTenant["status"]): string {
    return {
      ONBOARDING: "Aguardando primeiro acesso",
      ACTIVE: "Ativa",
      SUSPENDED: "Suspensa",
    }[status];
  }

  protected dateLabel(value: string): string {
    const date = new Date(value);
    return Number.isNaN(date.valueOf())
      ? "—"
      : new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(date);
  }

  protected durationLabel(seconds: number): string {
    const hours = Math.max(1, Math.floor(seconds / 3600));
    return hours === 1 ? "1 hora" : `${hours} horas`;
  }

  protected async logout(): Promise<void> {
    void this.session.logout();
    await this.router.navigateByUrl("/entrar");
  }
}
