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
import { apiStatus, errorMessage } from "../core/api";
import {
  isUncertainTransitionError,
  OrdersApi,
  type OrderStatus,
  type StaffOrder,
} from "./orders-api";

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
          [disabled]="loading() || paging()"
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
      @if (pendingOrderIds().length > 0) {
        <aside class="pending-intents" aria-label="Operações pendentes">
          <h2>Operações aguardando confirmação</h2>
          @for (orderId of pendingOrderIds(); track orderId) {
            <div class="pending-intent" role="status">
              <span>{{ pendingOrderLabel(orderId) }}</span>
              @if (api.requiresReconciliation(orderId)) {
                <button
                  class="button button--secondary"
                  type="button"
                  [disabled]="busyId() === orderId"
                  (click)="reconcilePending(orderId)"
                >
                  Reconciliar estado
                </button>
              } @else {
                <button
                  class="button"
                  type="button"
                  [disabled]="busyId() === orderId"
                  (click)="retryPending(orderId)"
                >
                  Verificar / repetir ação
                </button>
              }
            </div>
          }
        </aside>
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
                    [disabled]="
                      busyId() === order.id || api.hasUncertainIntent(order.id)
                    "
                    (click)="advance(order)"
                  >
                    {{ actionLabel(order) }}
                  </button>
                }
                @if (api.hasUncertainIntent(order.id)) {
                  <p role="status">
                    A confirmação desta ação não chegou. Consulte as operações
                    pendentes para reconciliar ou repetir com segurança.
                  </p>
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
                    [disabled]="
                      busyId() === order.id || api.hasUncertainIntent(order.id)
                    "
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

      <nav class="pagination" aria-label="Paginação de pedidos">
        @if (activeCursor() !== null) {
          <button
            class="button button--secondary"
            type="button"
            (click)="loadMore('active')"
            [disabled]="paging() || loading() || busyId() !== null"
          >
            Carregar mais pedidos ativos
          </button>
        }
        @if (closedCursor() !== null) {
          <button
            class="button button--secondary"
            type="button"
            (click)="loadMore('closed')"
            [disabled]="paging() || loading() || busyId() !== null"
          >
            Carregar histórico
          </button>
        }
      </nav>

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
      @if (printOrder(); as receipt) {
        <section
          #printReceipt
          class="receipt"
          aria-label="Comanda para impressão"
        >
          <h1>Comanda · Pedido #{{ receipt.number }}</h1>
          <p>{{ receipt.placedAt | date: "dd/MM/yyyy HH:mm" }}</p>
          <p>
            <strong>{{ receipt.customerName }}</strong>
          </p>
          @if (receipt.customerPhone) {
            <p>{{ receipt.customerPhone }}</p>
          }
          <p>
            {{ receipt.fulfillment === "DELIVERY" ? "Entrega" : "Retirada" }}
          </p>
          @if (
            receipt.fulfillment === "DELIVERY" && receipt.deliveryAddress;
            as address
          ) {
            <p>
              {{ address.street
              }}{{ address.number ? ", " + address.number : ""
              }}{{ address.complement ? " · " + address.complement : ""
              }}<br />{{ address.district }}, {{ address.city }} -
              {{ address.state }} · {{ address.postalCode }}
            </p>
            @if (address.reference) {
              <p>Referência: {{ address.reference }}</p>
            }
          }
          <hr />
          <ul class="receipt-items">
            @for (item of receipt.items; track $index) {
              <li>
                <strong>{{ item.quantity }}× {{ itemName(item) }}</strong
                ><span>{{ item.totalCents / 100 | currency: "BRL" }}</span>
                @if (itemDetails(item); as details) {
                  <small>{{ details }}</small>
                }
              </li>
            }
          </ul>
          @if (receipt.notes) {
            <p><strong>Observação:</strong> {{ receipt.notes }}</p>
          }
          <p>Pagamento: {{ paymentLabel(receipt.paymentMethod) }}</p>
          @if (receipt.changeForCents) {
            <p>
              Troco para: {{ receipt.changeForCents / 100 | currency: "BRL" }}
            </p>
          }
          <hr />
          <p>
            Subtotal: {{ receipt.itemsSubtotalCents / 100 | currency: "BRL" }}
          </p>
          <p>
            Taxa de entrega:
            {{ receipt.deliveryFeeCents / 100 | currency: "BRL" }}
          </p>
          @if (receipt.discountCents) {
            <p>Desconto: {{ receipt.discountCents / 100 | currency: "BRL" }}</p>
          }
          <h2>Total: {{ receipt.totalCents / 100 | currency: "BRL" }}</h2>
        </section>
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
    .pending-intents {
      display: grid;
      gap: var(--wo-spacing-2);
      margin-bottom: var(--wo-spacing-4);
      padding: var(--wo-spacing-3);
      border: 1px solid var(--wo-color-border);
      border-radius: var(--wo-radius-small);
      background: var(--wo-color-orangeSoft);
    }
    .pending-intents h2 {
      margin: 0;
      font-size: 1rem;
    }
    .pending-intent {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--wo-spacing-3);
      flex-wrap: wrap;
    }
    .pagination {
      display: flex;
      gap: var(--wo-spacing-3);
      justify-content: center;
      flex-wrap: wrap;
    }
    .receipt {
      display: none;
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
      .receipt,
      .receipt * {
        visibility: visible;
      }
      .receipt {
        display: block;
        position: absolute;
        inset: 0 auto auto 0;
        width: 72mm;
        color: #000;
        background: #fff;
        padding: 3mm;
        font: 10pt/1.3 monospace;
      }
      .receipt h1,
      .receipt h2 {
        font-size: 12pt;
      }
      .receipt-items {
        list-style: none;
        padding: 0;
      }
      .receipt-items li {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 2mm;
        padding: 2mm 0;
      }
      .receipt-items small {
        grid-column: 1 / -1;
      }
      .detail,
      .pagination,
      .orders-heading,
      .board,
      .new-orders,
      .pending-intents,
      .status--error {
        display: none !important;
      }
      @page {
        margin: 5mm;
        size: auto;
      }
    }
  `,
})
export class OrdersPage {
  protected readonly api = inject(OrdersApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly detailDialog =
    viewChild<ElementRef<HTMLDialogElement>>("detailDialog");
  private readonly printReceipt =
    viewChild<ElementRef<HTMLElement>>("printReceipt");
  protected readonly orders = signal<StaffOrder[]>([]);
  protected readonly selected = signal<StaffOrder | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal("");
  protected readonly busyId = signal<string | null>(null);
  protected readonly paging = signal(false);
  protected readonly activeCursor = signal<number | null>(null);
  protected readonly closedCursor = signal<number | null>(null);
  protected readonly printOrder = signal<StaffOrder | null>(null);
  protected readonly now = signal(Date.now());
  protected readonly reasons = REASONS;
  private readonly newlyArrived = signal(new Set<string>());
  private audio: AudioContext | null = null;
  private activeCursors: (number | undefined)[] = [undefined];
  private closedCursors: (number | undefined)[] = [undefined];
  private refreshPromise: Promise<void> | null = null;
  private refreshQueued = false;
  private destroyed = false;
  private printedOrderId: string | null = null;
  private mutationVersion = 0;
  private hasLoadedOnce = false;
  protected readonly soundEnabled = signal(false);
  protected readonly newCount = computed(() => this.newlyArrived().size);
  protected readonly columns = computed(() =>
    STATUS.map((column) => ({
      ...column,
      orders: this.orders().filter((order) => order.status === column.id),
    })),
  );
  protected readonly pendingOrderIds = computed(() => {
    this.api.pendingVersion();
    return this.api.pendingOrderIds();
  });

  constructor() {
    effect(() => {
      const shouldOpen = this.selected() !== null;
      const dialog = this.detailDialog()?.nativeElement;
      if (!dialog) return;
      if (shouldOpen && !dialog.open) dialog.showModal();
      else if (!shouldOpen && dialog.open) dialog.close();
    });
    effect(() => {
      const order = this.printOrder();
      const receipt = this.printReceipt()?.nativeElement;
      if (!order || !receipt || this.printedOrderId === order.id) return;
      this.printedOrderId = order.id;
      requestAnimationFrame(() => {
        if (
          !this.destroyed &&
          this.printOrder()?.id === order.id &&
          receipt.isConnected
        )
          window.print();
      });
    });
    const afterPrint = () => {
      this.printOrder.set(null);
      this.printedOrderId = null;
    };
    window.addEventListener("afterprint", afterPrint);
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
      window.removeEventListener("afterprint", afterPrint);
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
    if (this.refreshPromise) {
      this.refreshQueued = true;
      return this.refreshPromise;
    }
    if (this.busyId() || this.paging()) {
      this.refreshQueued = true;
      return;
    }
    this.loading.set(true);
    this.refreshPromise = this.refreshLoadedPages();
    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
      this.loading.set(false);
      if (this.refreshQueued && !this.busyId() && !this.destroyed) {
        this.refreshQueued = false;
        void this.load();
      }
    }
  }

  private async refreshLoadedPages(): Promise<void> {
    const version = this.mutationVersion;
    const results = await Promise.allSettled([
      this.refreshSection("active", this.activeCursors.length),
      this.refreshSection("closed", this.closedCursors.length),
    ]);
    if (this.destroyed || this.busyId() || version !== this.mutationVersion) {
      this.refreshQueued = true;
      return;
    }
    const successfulSections = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<{
        section: "active" | "closed";
        pages: {
          cursor: number | undefined;
          page: Awaited<ReturnType<OrdersApi["list"]>>;
        }[];
      }> => result.status === "fulfilled",
    );
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length)
      this.error.set(
        errorMessage((failures[0] as PromiseRejectedResult).reason),
      );
    else this.error.set("");
    if (!successfulSections.length) return;
    const successful = successfulSections.flatMap(
      (result) => result.value.pages,
    );
    const incoming = successful.flatMap(({ page }) => page.orders);
    // A partial response cannot prove that missing rows changed status. Retain the previous
    // snapshot until every loaded page in both independent queues has been reconciled.
    const map = new Map(
      failures.length ? this.orders().map((order) => [order.id, order]) : [],
    );
    for (const order of incoming) map.set(order.id, order);
    const merged = [...map.values()];
    const known = new Set(this.orders().map((order) => order.id));
    const newOrders = incoming.filter(
      (order) => !known.has(order.id) && order.status === "PLACED",
    );
    this.newlyArrived.update((ids) => {
      const visible = new Set(
        merged
          .filter((order) => order.status === "PLACED")
          .map((order) => order.id),
      );
      return new Set([...ids].filter((id) => visible.has(id)));
    });
    if (this.hasLoadedOnce && newOrders.length) {
      this.newlyArrived.update(
        (ids) => new Set([...ids, ...newOrders.map((order) => order.id)]),
      );
      this.playAlert();
    }
    if (!failures.length) this.hasLoadedOnce = true;
    merged.sort((a, b) => a.number - b.number);
    this.orders.set(merged);
    const selectedId = this.selected()?.id;
    if (selectedId) {
      const selectedOrder = merged.find((order) => order.id === selectedId);
      if (selectedOrder) this.selected.set(selectedOrder);
      else if (!failures.length)
        await this.reconcileSelected(selectedId, version);
    }
    for (const result of successfulSections.map((item) => item.value)) {
      const cursors = result.pages.map((page) => page.cursor);
      const lastCursor = result.pages.at(-1)?.page.nextCursor ?? null;
      if (result.section === "active") {
        this.activeCursors = cursors.length ? cursors : [undefined];
        this.activeCursor.set(lastCursor);
      } else {
        this.closedCursors = cursors.length ? cursors : [undefined];
        this.closedCursor.set(lastCursor);
      }
    }
  }

  private async refreshSection(
    section: "active" | "closed",
    loadedPageCount: number,
  ): Promise<{
    section: "active" | "closed";
    pages: {
      cursor: number | undefined;
      page: Awaited<ReturnType<OrdersApi["list"]>>;
    }[];
  }> {
    const pages: {
      cursor: number | undefined;
      page: Awaited<ReturnType<OrdersApi["list"]>>;
    }[] = [];
    let cursor: number | undefined;
    for (let index = 0; index < loadedPageCount; index++) {
      const page = await this.api.list(section, cursor);
      pages.push({ cursor, page });
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return { section, pages };
  }

  private async reconcileSelected(
    orderId: string,
    version: number,
  ): Promise<void> {
    try {
      const order = await this.api.get(orderId);
      if (
        !this.destroyed &&
        version === this.mutationVersion &&
        this.selected()?.id === orderId
      )
        this.selected.set(order);
    } catch (error) {
      if (this.destroyed || version !== this.mutationVersion) return;
      if (apiStatus(error) === 404) {
        if (this.selected()?.id === orderId) this.selected.set(null);
      } else {
        this.error.set(errorMessage(error));
      }
    }
  }

  protected async loadMore(section: "active" | "closed"): Promise<void> {
    if (this.paging() || this.busyId()) {
      this.refreshQueued = true;
      return;
    }
    if (this.refreshPromise) await this.refreshPromise;
    if (this.destroyed || this.paging() || this.busyId()) return;
    const cursors =
      section === "active" ? this.activeCursors : this.closedCursors;
    const nextCursor =
      section === "active" ? this.activeCursor() : this.closedCursor();
    if (nextCursor === null) return;
    const version = this.mutationVersion;
    this.paging.set(true);
    try {
      const page = await this.api.list(section, nextCursor);
      if (this.destroyed) return;
      if (version !== this.mutationVersion || this.busyId()) {
        this.refreshQueued = true;
        return;
      }
      cursors.push(nextCursor);
      const byId = new Map(this.orders().map((order) => [order.id, order]));
      page.orders.forEach((order) => byId.set(order.id, order));
      this.orders.set([...byId.values()].sort((a, b) => a.number - b.number));
      if (section === "active") this.activeCursor.set(page.nextCursor);
      else this.closedCursor.set(page.nextCursor);
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.paging.set(false);
      if (this.refreshQueued && !this.busyId() && !this.destroyed) {
        this.refreshQueued = false;
        void this.load();
      }
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
    if (this.busyId() || this.api.pendingIntent(order.id)?.uncertain) return;
    this.mutationVersion++;
    this.busyId.set(order.id);
    try {
      await this.api.transition(order, to, reasonCode, reasonText);
    } catch (error) {
      if (isUncertainTransitionError(error))
        this.error.set(
          "Não foi possível confirmar a resposta. O pedido permanece pendente; use “Verificar / repetir ação” para repetir com a mesma chave.",
        );
      else this.error.set(errorMessage(error));
    } finally {
      this.busyId.set(null);
      this.refreshQueued = true;
      await this.load();
    }
  }
  protected async retry(order: StaffOrder): Promise<void> {
    await this.retryPending(order.id);
  }

  protected pendingOrderLabel(orderId: string): string {
    const order = this.orders().find((item) => item.id === orderId);
    return order ? `Pedido #${order.number}` : `Pedido …${orderId.slice(-6)}`;
  }

  protected async retryPending(orderId: string): Promise<void> {
    if (this.busyId()) return;
    this.mutationVersion++;
    this.busyId.set(orderId);
    try {
      const result = await this.api.retryPending(orderId);
      this.replaceOrder(result.order);
      this.error.set("");
    } catch (error) {
      if (isUncertainTransitionError(error))
        this.error.set(
          "A confirmação ainda não chegou. A chave foi preservada; tente novamente quando a conexão estiver estável.",
        );
      else this.error.set(errorMessage(error));
    } finally {
      this.busyId.set(null);
      this.refreshQueued = true;
      await this.load();
    }
  }

  protected async reconcilePending(orderId: string): Promise<void> {
    if (this.busyId()) return;
    this.mutationVersion++;
    this.busyId.set(orderId);
    try {
      const result = await this.api.reconcilePending(orderId);
      this.replaceOrder(result.order);
      this.error.set(
        result.canRetry
          ? "O pedido ainda está no estado original. A operação pode ser repetida com a mesma chave."
          : "O pedido mudou de estado. O quadro foi atualizado; confira antes de iniciar outra ação.",
      );
    } catch (error) {
      this.error.set(errorMessage(error));
    } finally {
      this.busyId.set(null);
      this.refreshQueued = true;
      await this.load();
    }
  }

  private replaceOrder(order: StaffOrder): void {
    const byId = new Map(this.orders().map((item) => [item.id, item]));
    byId.set(order.id, order);
    this.orders.set([...byId.values()].sort((a, b) => a.number - b.number));
    if (this.selected()?.id === order.id) this.selected.set(order);
  }
  protected print(order: StaffOrder): void {
    this.printOrder.set(order);
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
