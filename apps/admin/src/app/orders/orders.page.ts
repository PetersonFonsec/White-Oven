import { CurrencyPipe, DatePipe } from "@angular/common";
import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import { takeUntilDestroyed } from "@angular/core/rxjs-interop";
import { interval } from "rxjs";
import { errorMessage } from "../core/api";
import { OrdersApi, type OrderStatus, type StaffOrder } from "./orders-api";

const STATUS: { id: OrderStatus; label: string }[] = [
  { id: "PLACED", label: "Novos" },
  { id: "PREPARING", label: "Em preparo" },
  { id: "READY", label: "Prontos" },
  { id: "OUT_FOR_DELIVERY", label: "Em entrega" },
  { id: "COMPLETED", label: "Concluídos" },
  { id: "REJECTED", label: "Recusados" },
  { id: "CANCELED", label: "Cancelados" },
];

const REASONS = [
  { code: "ITEM_UNAVAILABLE", label: "Item indisponível" },
  { code: "STORE_TOO_BUSY", label: "Loja muito ocupada" },
  { code: "OUT_OF_DELIVERY_AREA", label: "Fora da área de entrega" },
  { code: "CUSTOMER_UNREACHABLE", label: "Cliente não localizado" },
  { code: "NOT_PICKED_UP", label: "Não retirado" },
  { code: "SUSPECTED_FRAUD", label: "Suspeita de fraude" },
  { code: "OTHER", label: "Outro motivo" },
];

const PAYMENT_LABELS: Record<string, string> = {
  CASH: "Dinheiro",
  CARD_ON_DELIVERY: "Cartão na entrega ou retirada",
  PIX_ON_DELIVERY: "Pix presencial",
};

@Component({
  selector: "wo-orders-page",
  imports: [CurrencyPipe, DatePipe],
  template: `
    <section aria-labelledby="orders-title">
      <header class="orders-heading">
        <div>
          <h1 id="orders-title" tabindex="-1" data-page-title>Pedidos</h1>
          <p class="muted">Atualiza automaticamente a cada 10 segundos.</p>
        </div>
        <button
          class="button button--secondary"
          type="button"
          (click)="load()"
          [disabled]="loading()"
        >
          Atualizar
        </button>
        <button
          class="button button--secondary"
          type="button"
          (click)="enableSound()"
          [attr.aria-pressed]="soundEnabled()"
        >
          {{ soundEnabled() ? "Som ativado" : "Ativar alerta sonoro" }}
        </button>
      </header>
      @if (newCount() > 0) {
        <p class="new-orders" role="status">
          {{ newCount() }} pedido(s) novo(s) chegaram.
        </p>
      }
      @if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }
      @if (loading() && orders().length === 0) {
        <p role="status">Carregando pedidos…</p>
      }
      @if (!loading() && orders().length === 0) {
        <p class="empty">Nenhum pedido encontrado.</p>
      }

      <div class="board" aria-label="Quadro de pedidos">
        @for (column of columns(); track column.id) {
          <section
            class="column"
            [attr.aria-labelledby]="'column-' + column.id"
          >
            <h2 [id]="'column-' + column.id">
              {{ column.label }} <span>{{ column.orders.length }}</span>
            </h2>
            @for (order of column.orders; track order.id) {
              <article
                class="order-card"
                [class.order-card--new]="isNew(order)"
                [class.order-card--selected]="selected()?.id === order.id"
              >
                <button
                  class="order-open"
                  type="button"
                  (click)="select(order)"
                  [attr.aria-label]="
                    'Detalhes do pedido número ' + order.number
                  "
                >
                  <strong
                    >#{{ order.number }} · {{ order.customerName }}</strong
                  >
                  <span
                    >{{ order.placedAt | date: "HH:mm" }} · há
                    {{ elapsed(order) }}</span
                  >
                  <span
                    >{{
                      order.fulfillment === "DELIVERY" ? "Entrega" : "Retirada"
                    }}
                    · {{ order.totalCents / 100 | currency: "BRL" }}</span
                  >
                </button>
                @if (canAdvance(order)) {
                  <button
                    class="button"
                    type="button"
                    [disabled]="busyId() === order.id"
                    (click)="advance(order)"
                  >
                    {{ actionLabel(order) }}
                  </button>
                }
                @if (
                  order.status === "PLACED" ||
                  order.status === "PREPARING" ||
                  order.status === "READY" ||
                  order.status === "OUT_FOR_DELIVERY"
                ) {
                  <button
                    class="button button--secondary"
                    type="button"
                    [disabled]="busyId() === order.id"
                    (click)="closeOrder(order, 'CANCELED')"
                  >
                    Cancelar pedido
                  </button>
                  @if (order.status === "PLACED") {
                    <label class="reason-label"
                      >Recusar por
                      <select
                        [value]="''"
                        (change)="reject(order, $any($event.target).value)"
                      >
                        <option value="" disabled>Escolha o motivo</option>
                        @for (reason of reasons; track reason.code) {
                          <option [value]="reason.code">
                            {{ reason.label }}
                          </option>
                        }
                      </select>
                    </label>
                  }
                }
              </article>
            }
            @if (column.orders.length === 0) {
              <p class="muted empty-column">Sem pedidos</p>
            }
          </section>
        }
      </div>

      @if (selected(); as order) {
        <dialog
          #detailDialog
          class="detail"
          aria-modal="true"
          aria-labelledby="detail-title"
          (close)="selected.set(null)"
        >
          <div class="detail-head">
            <h2 id="detail-title">Pedido #{{ order.number }}</h2>
            <button
              class="button button--secondary"
              type="button"
              autofocus
              (click)="selected.set(null)"
            >
              Fechar
            </button>
          </div>
          <p>
            <strong>{{ order.customerName }}</strong> ·
            {{ order.customerPhone || "Sem telefone" }}
          </p>
          <p>
            {{ order.fulfillment === "DELIVERY" ? "Entrega" : "Retirada" }} ·
            {{ paymentLabel(order.paymentMethod) }} ·
            {{ order.placedAt | date: "dd/MM/yyyy HH:mm" }}
          </p>
          @if (order.deliveryAddress; as address) {
            <p>
              {{ address.street
              }}{{ address.number ? ", " + address.number : "" }} ·
              {{ address.district }}, {{ address.city }} - {{ address.state }}
            </p>
          }
          <ul class="items">
            @for (item of order.items; track $index) {
              <li>
                <span>
                  {{ item.quantity }}× {{ itemName(item) }}
                  @if (itemDetails(item); as details) {
                    <small>{{ details }}</small>
                  }</span
                ><strong>{{ item.totalCents / 100 | currency: "BRL" }}</strong>
              </li>
            }
          </ul>
          @if (order.notes) {
            <p><strong>Observação:</strong> {{ order.notes }}</p>
          }
          <p>
            <strong>Total:</strong>
            {{ order.totalCents / 100 | currency: "BRL" }}
            @if (order.changeForCents) {
              · Troco para {{ order.changeForCents / 100 | currency: "BRL" }}
            }
          </p>
          <h3>Histórico</h3>
          <ol class="history">
            @for (change of order.history; track $index) {
              <li>
                {{ statusLabel(change.to) }} ·
                {{ change.at | date: "dd/MM HH:mm:ss" }}
                @if (change.reasonCode) {
                  · {{ reasonLabel(change.reasonCode) }}
                }
                @if (change.reasonText) {
                  — {{ change.reasonText }}
                }
              </li>
            }
          </ol>
          <button
            class="button button--secondary"
            type="button"
            (click)="print(order)"
          >
            Imprimir comanda
          </button>
        </dialog>
      }
    </section>
  `,
  styles: `
    .orders-heading,
    .detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--wo-spacing-4);
    }
    .orders-heading {
      margin-bottom: var(--wo-spacing-5);
    }
    .board {
      display: grid;
      grid-template-columns: repeat(4, minmax(230px, 1fr));
      gap: var(--wo-spacing-4);
      align-items: start;
      overflow-x: auto;
      padding-bottom: var(--wo-spacing-4);
    }
    .column {
      min-width: 230px;
      padding: var(--wo-spacing-3);
      border-radius: var(--wo-radius-card);
      background: var(--wo-color-surface);
      border: 1px solid var(--wo-color-border);
    }
    .column h2 {
      display: flex;
      justify-content: space-between;
      font-size: 1rem;
    }
    .column h2 span {
      color: var(--wo-color-muted);
    }
    .order-card {
      display: grid;
      gap: var(--wo-spacing-2);
      margin-bottom: var(--wo-spacing-3);
      padding: var(--wo-spacing-3);
      border: 1px solid var(--wo-color-border);
      border-radius: var(--wo-radius-small);
      background: white;
    }
    .order-card--new {
      border-color: var(--wo-color-primary);
      box-shadow: 0 0 0 2px var(--wo-color-orangeSoft);
    }
    .order-card--selected {
      outline: 2px solid var(--wo-color-focus);
    }
    .order-open {
      display: grid;
      gap: var(--wo-spacing-1);
      padding: 0;
      border: 0;
      background: none;
      color: var(--wo-color-text);
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .reason-label {
      display: grid;
      gap: var(--wo-spacing-1);
      font-size: 0.9rem;
    }
    .reason-label select {
      min-height: var(--wo-interaction-minimumTarget);
      font: inherit;
    }
    .empty,
    .empty-column {
      padding: var(--wo-spacing-4);
      text-align: center;
    }
    .new-orders {
      padding: var(--wo-spacing-3);
      background: var(--wo-color-orangeSoft);
      border-radius: var(--wo-radius-small);
    }
    .detail {
      position: fixed;
      z-index: 20;
      inset: 50% auto auto 50%;
      transform: translate(-50%, -50%);
      width: min(620px, calc(100vw - 32px));
      max-height: 85vh;
      overflow: auto;
      padding: var(--wo-spacing-6);
      border: 1px solid var(--wo-color-border);
      border-radius: var(--wo-radius-card);
      background: var(--wo-color-surface);
      box-shadow: var(--wo-shadow-card);
    }
    .detail::backdrop {
      background: #18201dcc;
    }
    .items,
    .history {
      padding-left: 1.4rem;
    }
    .items small {
      display: block;
      color: var(--wo-color-muted);
    }
    .items li {
      display: flex;
      justify-content: space-between;
      gap: var(--wo-spacing-4);
      padding: var(--wo-spacing-2) 0;
      border-bottom: 1px solid var(--wo-color-border);
    }
    @media (max-width: 800px) {
      .board {
        grid-template-columns: repeat(4, minmax(250px, 82vw));
      }
      .detail {
        padding: var(--wo-spacing-4);
      }
    }
    @media print {
      body * {
        visibility: hidden;
      }
      .detail,
      .detail * {
        visibility: visible;
      }
      .detail {
        position: absolute;
        inset: 0;
        transform: none;
        width: 100%;
        max-height: none;
        box-shadow: none;
        border: 0;
      }
      .detail-head button,
      .detail > button {
        display: none;
      }
    }
  `,
})
export class OrdersPage {
  private readonly api = inject(OrdersApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly detailDialog =
    viewChild<ElementRef<HTMLDialogElement>>("detailDialog");
  protected readonly orders = signal<StaffOrder[]>([]);
  protected readonly selected = signal<StaffOrder | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal("");
  protected readonly busyId = signal<string | null>(null);
  protected readonly now = signal(Date.now());
  protected readonly reasons = REASONS;
  private readonly newlyArrived = signal(new Set<string>());
  private audio: AudioContext | null = null;
  private loadVersion = 0;
  protected readonly soundEnabled = signal(false);
  protected readonly newCount = computed(() => this.newlyArrived().size);
  protected readonly columns = computed(() =>
    STATUS.map((column) => ({
      ...column,
      orders: this.orders().filter((order) => order.status === column.id),
    })),
  );

  constructor() {
    effect(() => {
      const shouldOpen = this.selected() !== null;
      const dialog = this.detailDialog()?.nativeElement;
      if (!dialog) return;
      if (shouldOpen && !dialog.open) dialog.showModal();
      else if (!shouldOpen && dialog.open) dialog.close();
    });
    this.destroyRef.onDestroy(() => {
      if (this.audio && this.audio.state !== "closed") void this.audio.close();
    });
    void this.load();
    interval(10_000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => void this.load());
    interval(30_000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.now.set(Date.now()));
  }

  protected async load(): Promise<void> {
    const version = ++this.loadVersion;
    try {
      const incoming = await this.api.list();
      if (version !== this.loadVersion) return;
      const known = new Set(this.orders().map((order) => order.id));
      const newOrders = incoming.filter(
        (order) => !known.has(order.id) && order.status === "PLACED",
      );
      const visibleIds = new Set(
        incoming
          .filter((order) => order.status === "PLACED")
          .map((order) => order.id),
      );
      this.newlyArrived.update(
        (ids) => new Set([...ids].filter((id) => visibleIds.has(id))),
      );
      if (known.size && newOrders.length) {
        this.newlyArrived.update((ids) => {
          const next = new Set(ids);
          for (const order of newOrders) next.add(order.id);
          return next;
        });
        this.playAlert();
      }
      this.orders.set(incoming);
      const selectedId = this.selected()?.id;
      this.selected.set(
        selectedId
          ? (incoming.find((order) => order.id === selectedId) ?? null)
          : null,
      );
      this.error.set("");
    } catch (error) {
      if (version === this.loadVersion) this.error.set(errorMessage(error));
    } finally {
      if (version === this.loadVersion) this.loading.set(false);
    }
  }

  protected select(order: StaffOrder): void {
    this.selected.set(order);
    this.newlyArrived.update((ids) => {
      const next = new Set(ids);
      next.delete(order.id);
      return next;
    });
  }

  protected async enableSound(): Promise<void> {
    try {
      this.audio ??= new AudioContext();
      await this.audio.resume();
      this.soundEnabled.set(this.audio.state === "running");
    } catch {
      this.error.set("O navegador não permitiu ativar o alerta sonoro.");
    }
  }

  protected isNew(order: StaffOrder): boolean {
    return this.newlyArrived().has(order.id);
  }
  protected elapsed(order: StaffOrder): string {
    const seconds = Math.max(
      0,
      Math.floor((this.now() - Date.parse(order.placedAt)) / 1000),
    );
    return `${Math.floor(seconds / 60)} min`;
  }
  protected canAdvance(order: StaffOrder): boolean {
    return ["PLACED", "PREPARING", "READY", "OUT_FOR_DELIVERY"].includes(
      order.status,
    );
  }
  protected actionLabel(order: StaffOrder): string {
    if (order.status === "PLACED") return "Aceitar pedido";
    if (order.status === "PREPARING") return "Marcar pronto";
    if (order.status === "READY")
      return order.fulfillment === "PICKUP"
        ? "Concluir retirada"
        : "Saiu para entrega";
    return "Marcar entregue";
  }
  protected statusLabel(status: OrderStatus): string {
    return STATUS.find((item) => item.id === status)?.label ?? status;
  }
  protected paymentLabel(method: string): string {
    return PAYMENT_LABELS[method] ?? method;
  }
  protected reasonLabel(code: string): string {
    return REASONS.find((reason) => reason.code === code)?.label ?? code;
  }
  protected itemName(item: StaffOrder["items"][number]): string {
    const snap = item.snapshot;
    if (item.kind === "PRODUCT") {
      const product = snap["product"] as { name?: unknown } | undefined;
      return typeof product?.name === "string" ? product.name : "Produto";
    }
    const size = snap["size"] as { name?: unknown } | undefined;
    const flavors = snap["flavors"] as
      Record<string, { name?: unknown } | undefined> | undefined;
    const names = [flavors?.["LEFT"]?.name, flavors?.["RIGHT"]?.name].filter(
      (name): name is string => typeof name === "string",
    );
    return `${typeof size?.name === "string" ? size.name : "Pizza"} · ${names.join(" / ") || "Sabores"}`;
  }
  protected itemDetails(item: StaffOrder["items"][number]): string {
    if (item.kind !== "PIZZA") return "";
    const snapshot = item.snapshot;
    const crust = snapshot["crust"] as { name?: unknown } | null;
    const extras = snapshot["extras"] as { name?: unknown }[] | undefined;
    const removals = snapshot["removals"] as { name?: unknown }[] | undefined;
    return [
      typeof crust?.name === "string" ? `Borda: ${crust.name}` : "",
      extras?.length
        ? `Adicionais: ${extras
            .map((item) => item.name)
            .filter((name): name is string => typeof name === "string")
            .join(", ")}`
        : "",
      removals?.length
        ? `Sem: ${removals
            .map((item) => item.name)
            .filter((name): name is string => typeof name === "string")
            .join(", ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }

  protected async advance(order: StaffOrder): Promise<void> {
    const to: OrderStatus =
      order.status === "PLACED"
        ? "PREPARING"
        : order.status === "PREPARING"
          ? "READY"
          : order.status === "READY"
            ? order.fulfillment === "PICKUP"
              ? "COMPLETED"
              : "OUT_FOR_DELIVERY"
            : "COMPLETED";
    await this.perform(order, to);
  }
  protected async closeOrder(order: StaffOrder, to: "CANCELED"): Promise<void> {
    const reasonLabel = window.prompt(
      `Motivo (${REASONS.map((reason) => reason.label).join(", ")})`,
      "Loja muito ocupada",
    );
    if (!reasonLabel) return;
    const reason = REASONS.find(
      (item) =>
        item.label.toLocaleLowerCase() ===
        reasonLabel.trim().toLocaleLowerCase(),
    );
    if (!reason) {
      this.error.set("Use um dos motivos exibidos para cancelar.");
      return;
    }
    const reasonText =
      reason.code === "OTHER" ? this.askReasonText() : undefined;
    if (reason.code === "OTHER" && !reasonText) return;
    await this.perform(order, to, reason.code, reasonText);
  }
  protected async reject(order: StaffOrder, reasonCode: string): Promise<void> {
    if (!reasonCode) return;
    const reasonText =
      reasonCode === "OTHER" ? this.askReasonText() : undefined;
    if (reasonCode === "OTHER" && !reasonText) return;
    await this.perform(order, "REJECTED", reasonCode, reasonText);
  }
  private askReasonText(): string | undefined {
    const text = window
      .prompt("Descreva o motivo (até 280 caracteres):")
      ?.trim();
    if (!text || [...text].length > 280) {
      this.error.set("O motivo deve ter entre 1 e 280 caracteres.");
      return undefined;
    }
    return text;
  }
  private async perform(
    order: StaffOrder,
    to: OrderStatus,
    reasonCode?: string,
    reasonText?: string,
  ): Promise<void> {
    if (this.busyId()) return;
    this.busyId.set(order.id);
    try {
      await this.api.transition(order, to, reasonCode, reasonText);
      await this.load();
    } catch (error) {
      await this.load();
      this.error.set(errorMessage(error));
    } finally {
      this.busyId.set(null);
    }
  }
  protected print(order: StaffOrder): void {
    this.selected.set(order);
    window.setTimeout(() => window.print(), 0);
  }
  private playAlert(): void {
    if (!this.soundEnabled() || !this.audio || this.audio.state !== "running")
      return;
    try {
      const context = this.audio;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.18, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(
        0.0001,
        context.currentTime + 0.35,
      );
      oscillator.connect(gain).connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.36);
    } catch {
      /* New-order highlight remains visible if the browser rejects audio. */
    }
  }
}
