import {
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { errorMessage } from "../core/api";
import { Session } from "../core/session";
import { type PauseMinutes, StoreApi, type StorePause } from "./store-api";

/** Margin after `pausedUntil` before asking the API, so the server already sees it expired. */
export const PAUSE_EXPIRY_MARGIN_MS = 1_000;
/** Wait before asking again when the API still reports a pause the browser clock sees expired. */
export const PAUSE_RECHECK_MS = 30_000;
/** Retries of a failed check after expiry; the reopened state stays shown meanwhile. */
export const PAUSE_SYNC_RETRIES = 3;

/**
 * Manual pause of new orders (order-lifecycle.md): any staff member pauses for 15, 30 or 60
 * minutes or until reopening, and the pause wins over the opening hours.
 *
 * The end time is shown in the store's time zone, which the API sends with the pause. A timed
 * pause reopens on screen when it expires, then the card asks the API, since someone may have
 * paused again meanwhile. One timer per pause, no polling. Every load, action and check takes a
 * ticket, and only the latest one publishes, so a slow answer never overwrites a newer state, a
 * store switch or a destroyed card.
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
            Pedidos pausados até {{ timeOf(current) }}.
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
  private readonly session = inject(Session);
  private readonly tenantId = computed(
    () => this.session.store()?.tenantId ?? null,
  );
  protected readonly options: PauseMinutes[] = [15, 30, 60];
  protected readonly pause = signal<StorePause | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal("");
  private ticket = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Loads now and again whenever the active store changes.
    effect(() => {
      this.tenantId();
      untracked(() => void this.load(true));
    });
    inject(DestroyRef).onDestroy(() => this.take());
  }

  protected start(minutes: PauseMinutes | null): Promise<void> {
    return this.run(() => this.api.startPause(minutes));
  }

  protected resume(): Promise<void> {
    return this.run(async () => {
      await this.api.endPause();
      return { ...this.pause()!, paused: false, pausedUntil: null };
    });
  }

  protected timeOf(pause: StorePause): string {
    const instant = new Date(pause.pausedUntil!);
    const options = { hour: "2-digit", minute: "2-digit" } as const;
    try {
      return instant.toLocaleTimeString("pt-BR", {
        ...options,
        timeZone: pause.timezone,
      });
    } catch {
      // An unknown zone name: say which clock the time is on rather than guess the browser's.
      return `${instant.toLocaleTimeString("pt-BR", { ...options, timeZone: "UTC" })} UTC`;
    }
  }

  /** Invalidates everything in flight and the timer; returns the new ticket. */
  private take(): number {
    clearTimeout(this.timer);
    this.timer = undefined;
    return ++this.ticket;
  }

  /**
   * `fresh`: a first load or another store, so the old state is dropped and a failure is shown.
   * Otherwise a check after expiry: the shown state stays and a failure is retried quietly.
   */
  private async load(fresh: boolean, attempt = 0): Promise<void> {
    const ticket = this.take();
    if (fresh) {
      this.pause.set(null);
      this.error.set("");
    }
    try {
      const pause = await this.api.pause();
      if (ticket === this.ticket) this.show(pause);
    } catch (error) {
      if (ticket !== this.ticket) return;
      if (!fresh && attempt < PAUSE_SYNC_RETRIES)
        this.timer = setTimeout(
          () => void this.load(false, attempt + 1),
          PAUSE_RECHECK_MS,
        );
      else this.error.set(errorMessage(error));
    }
  }

  private show(pause: StorePause): void {
    this.pause.set(pause);
    if (!pause.paused || !pause.pausedUntil) return;
    const left = Date.parse(pause.pausedUntil) - Date.now();
    this.timer = setTimeout(
      () => this.expire(),
      // The API still reports a pause this clock sees as over: the clocks differ, ask later.
      left > 0 ? left + PAUSE_EXPIRY_MARGIN_MS : PAUSE_RECHECK_MS,
    );
  }

  private expire(): void {
    this.pause.update(
      (pause) => pause && { ...pause, paused: false, pausedUntil: null },
    );
    void this.load(false);
  }

  private async run(action: () => Promise<StorePause>): Promise<void> {
    if (this.saving()) return;
    const ticket = this.take();
    this.saving.set(true);
    this.error.set("");
    try {
      const pause = await action();
      if (ticket === this.ticket) this.show(pause);
    } catch (error) {
      if (ticket !== this.ticket) return;
      this.error.set(errorMessage(error));
      // The pause on screen still stands: keep watching its end.
      const current = this.pause();
      if (current) this.show(current);
    } finally {
      this.saving.set(false);
    }
  }
}
