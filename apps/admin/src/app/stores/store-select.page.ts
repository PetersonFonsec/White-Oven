import { Component, type OnInit, inject, input, signal } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { errorMessage } from "../core/api";
import { ROLE_LABELS, Session, type TenantChoice } from "../core/session";

/** Stores the person can enter. With only one, it is entered directly unless switching. */
@Component({
  selector: "wo-store-select-page",
  imports: [RouterLink],
  template: `
    <main class="card" [attr.aria-busy]="loading()">
      <p class="brand">WhiteOven</p>
      <h1 tabindex="-1" data-page-title>Escolha a loja</h1>
      @if (loading()) {
        <p role="status">Carregando lojas…</p>
      } @else if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      } @else if (stores().length === 0) {
        <p>Você ainda não tem acesso a nenhuma loja.</p>
      } @else {
        <ul class="stores">
          @for (store of stores(); track store.tenantId) {
            <li>
              <button
                class="button button--secondary"
                type="button"
                [disabled]="busy()"
                (click)="enter(store.tenantId)"
              >
                {{ store.displayName }}
                <span class="muted">· {{ roleLabels[store.role] }}</span>
              </button>
            </li>
          }
        </ul>
      }
      <p>
        @if (isOperator()) {
          <a routerLink="/plataforma">Voltar para a plataforma</a> ·
        }
        <button class="button--link" type="button" (click)="logout()">
          Sair
        </button>
      </p>
    </main>
  `,
  styles: `
    .stores {
      display: grid;
      gap: var(--wo-spacing-3);
      margin: 0 0 var(--wo-spacing-5);
      padding: 0;
      list-style: none;
    }
    .stores .button {
      width: 100%;
      justify-content: flex-start;
      gap: var(--wo-spacing-2);
    }
  `,
})
export class StoreSelectPage implements OnInit {
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  /** `?trocar=1`: the person asked to switch, so a single store is not entered automatically. */
  readonly trocar = input<string>();

  protected readonly roleLabels = ROLE_LABELS;
  protected readonly stores = signal<TenantChoice[]>([]);
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly isOperator = () => this.session.platform() === "operator";

  async ngOnInit(): Promise<void> {
    try {
      this.stores.set(await this.session.tenants());
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.loading.set(false);
    }
    const [only] = this.stores();
    if (this.stores().length === 1 && !this.trocar() && !this.isOperator())
      await this.enter(only!.tenantId);
  }

  protected async enter(tenantId: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.session.selectStore(tenantId);
      await this.router.navigateByUrl("/loja");
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async logout(): Promise<void> {
    // Ends the session here at once; the revocation finishes in the background (Session.logout).
    void this.session.logout();
    await this.router.navigateByUrl("/entrar");
  }
}
