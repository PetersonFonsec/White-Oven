import { Component, computed, inject } from "@angular/core";
import {
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from "@angular/router";
import { ROLE_LABELS, Session } from "../core/session";
import { STORE_SECTIONS } from "./navigation";

/** Layout of the store area: header with the active store, sections allowed for the role. */
@Component({
  selector: "wo-store-shell",
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <a class="skip-link" href="#conteudo">Pular para o conteúdo</a>
    <header class="topbar">
      <span class="brand">WhiteOven</span>
      <span class="store">
        <strong>{{ store()?.displayName }}</strong>
        <span class="muted">{{ roleLabel() }}</span>
      </span>
      <span class="actions">
        <a routerLink="/lojas" [queryParams]="{ trocar: 1 }">Trocar loja</a>
        <button class="button--link" type="button" (click)="logout()">
          Sair
        </button>
      </span>
    </header>
    <div class="layout">
      <nav aria-label="Seções da loja">
        <ul>
          @for (section of sections(); track section.path) {
            <li>
              <a
                [routerLink]="['/loja', section.path]"
                routerLinkActive="active"
                [routerLinkActiveOptions]="{ exact: true }"
                ariaCurrentWhenActive="page"
                >{{ section.label }}</a
              >
            </li>
          }
        </ul>
      </nav>
      <main id="conteudo" tabindex="-1">
        <router-outlet />
      </main>
    </div>
  `,
  styles: `
    .topbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--wo-spacing-4);
      padding: var(--wo-spacing-3) var(--wo-spacing-5);
      background: var(--wo-color-surface);
      border-bottom: 1px solid var(--wo-color-border);
    }
    .store {
      display: grid;
      flex: 1;
    }
    .actions {
      display: flex;
      align-items: center;
      gap: var(--wo-spacing-4);
    }
    .layout {
      display: grid;
      grid-template-columns: 220px 1fr;
      min-height: calc(100vh - 72px);
    }
    nav ul {
      margin: 0;
      padding: var(--wo-spacing-4);
      list-style: none;
    }
    nav a {
      display: flex;
      align-items: center;
      min-height: var(--wo-interaction-minimumTarget);
      padding: 0 var(--wo-spacing-3);
      border-radius: var(--wo-radius-small);
      color: var(--wo-color-text);
      text-decoration: none;
    }
    nav a.active {
      background: var(--wo-color-orangeSoft);
      color: var(--wo-color-accentText);
    }
    main {
      padding: var(--wo-spacing-6);
    }
    @media (max-width: 768px) {
      .layout {
        grid-template-columns: 1fr;
      }
      nav ul {
        display: flex;
        flex-wrap: wrap;
        gap: var(--wo-spacing-2);
      }
    }
  `,
})
export class StoreShell {
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  protected readonly store = this.session.store;
  protected readonly roleLabel = computed(() => {
    const role = this.session.role();
    return role ? ROLE_LABELS[role] : "";
  });
  protected readonly sections = computed(() => {
    const role = this.session.role();
    return STORE_SECTIONS.filter(
      (section) => role !== null && section.roles.includes(role),
    );
  });

  protected async logout(): Promise<void> {
    await this.session.logout();
    await this.router.navigateByUrl("/entrar");
  }
}
