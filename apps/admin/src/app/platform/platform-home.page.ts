import { Component, inject } from "@angular/core";
import { Router, RouterLink } from "@angular/router";
import { Session } from "../core/session";

/** Operator landing. Tenants, invites and suspension arrive in M3.2. */
@Component({
  selector: "wo-platform-home-page",
  imports: [RouterLink],
  template: `
    <a class="skip-link" href="#conteudo">Pular para o conteúdo</a>
    <main id="conteudo" class="card" tabindex="-1">
      <p class="brand">WhiteOven · Plataforma</p>
      <h1 tabindex="-1" data-page-title>Plataforma</h1>
      <p>
        Você entrou como operador da WhiteOven, com verificação em duas etapas.
      </p>
      <p class="muted">
        A gestão de pizzarias, convites e suspensões chega na próxima etapa do
        painel.
      </p>
      <p>
        <a routerLink="/lojas" [queryParams]="{ trocar: 1 }">Abrir uma loja</a>
        ·
        <button class="button--link" type="button" (click)="logout()">
          Sair
        </button>
      </p>
    </main>
  `,
})
export class PlatformHomePage {
  private readonly session = inject(Session);
  private readonly router = inject(Router);

  protected async logout(): Promise<void> {
    await this.session.logout();
    await this.router.navigateByUrl("/entrar");
  }
}
