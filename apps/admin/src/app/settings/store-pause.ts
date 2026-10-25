import { Component, inject, signal } from "@angular/core";
import { errorMessage } from "../core/api";
import { type PauseMinutes, StoreApi, type StorePause } from "./store-api";

/**
 * Manual pause of new orders (order-lifecycle.md): any staff member pauses for 15, 30 or 60
 * minutes or until reopening, and the pause wins over the opening hours.
 */
@Component({
  selector: "wo-store-pause",
  template: `
    <section class="pause" aria-labelledby="pause-title">
      <h2 id="pause-title">Receber pedidos</h2>
      @if (pause(); as current) {
        <p role="status" [class.status--warning]="current.paused">
          @if (!current.paused) {
            A loja está recebendo pedidos nos horários de funcionamento.
          } @else if (current.pausedUntil) {
            Pedidos pausados até {{ timeOf(current.pausedUntil) }}.
          } @else {
            Pedidos pausados até alguém reabrir.
          }
        </p>
        <div class="pause-actions">
          @if (current.paused) {
            <button
              type="button"
              class="button"
              [disabled]="saving()"
              (click)="resume()"
            >
              Reabrir agora
            </button>
          }
          @for (minutes of options; track minutes) {
            <button
              type="button"
              class="button button--secondary"
              [disabled]="saving()"
              (click)="start(minutes)"
            >
              Pausar {{ minutes }} min
            </button>
          }
          <button
            type="button"
            class="button button--secondary"
            [disabled]="saving()"
            (click)="start(null)"
          >
            Pausar até reabrir
          </button>
        </div>
      } @else if (!error()) {
        <p role="status">Carregando…</p>
      }
      @if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }
    </section>
  `,
  styles: `
    .pause-actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--wo-spacing-2);
    }
  `,
})
export class StorePauseCard {
  private readonly api = inject(StoreApi);
  protected readonly options: PauseMinutes[] = [15, 30, 60];
  protected readonly pause = signal<StorePause | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal("");

  constructor() {
    this.api.pause().then(
      (pause) => this.pause.set(pause),
      (error: unknown) => this.error.set(errorMessage(error)),
    );
  }

  protected start(minutes: PauseMinutes | null): Promise<void> {
    return this.run(() => this.api.startPause(minutes));
  }

  protected resume(): Promise<void> {
    return this.run(async () => {
      await this.api.endPause();
      return { paused: false, pausedUntil: null };
    });
  }

  protected timeOf(instant: string): string {
    return new Date(instant).toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  private async run(action: () => Promise<StorePause>): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.error.set("");
    try {
      this.pause.set(await action());
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.saving.set(false);
    }
  }
}
