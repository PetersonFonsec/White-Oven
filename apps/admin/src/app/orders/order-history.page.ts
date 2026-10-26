import { CurrencyPipe, DatePipe } from "@angular/common";
import {
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  signal,
  viewChild,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { apiErrorCode, apiStatus, errorMessage } from "../core/api";
import {
  type HistoryEntry,
  type HistoryFilters,
  INCIDENT_TEXT_MAX_LENGTH,
  INCIDENT_TYPES,
  type IncidentType,
  type OrderDetail,
  type OrderIncident,
  OrderHistoryApi,
} from "./history-api";
import {
  FULFILLMENT_LABELS,
  PAYMENT_LABELS,
  REASON_LABELS,
  STATUS_LABELS,
  itemDetails,
  itemName,
} from "./order-labels";
import type { OrderStatus } from "./orders-api";

const INCIDENT_MESSAGES: Record<string, string> = {
  INCIDENT_WINDOW_CLOSED:
    "Ocorrências só podem ser registradas até 30 dias depois do fim do pedido.",
  INCIDENT_ALREADY_RESOLVED:
    "Outra pessoa já resolveu esta ocorrência. O pedido foi recarregado.",
  TENANT_NOT_ACTIVE:
    "Com a loja suspensa, só o dono pode registrar ou resolver ocorrências.",
  NOT_FOUND: "Este pedido não foi encontrado nesta loja.",
};

const incidentError = (error: unknown) =>
  INCIDENT_MESSAGES[apiErrorCode(error) ?? ""] ?? errorMessage(error);

/**
 * Order history of the active store (M4.6, ADR 0019): filters by local day, status, mode and
 * number, newest first with "load more"; the detail shows who moved the order and its incidents,
 * where any role records a new one or resolves an open one. Incidents never change the order.
 */
@Component({
  selector: "wo-order-history-page",
  imports: [CurrencyPipe, DatePipe, FormsModule],
  template: `
    <section aria-labelledby="history-title">
      <h1 id="history-title" tabindex="-1" data-page-title>Histórico</h1>
      <p class="muted">
        Todos os pedidos da loja, do mais novo ao mais antigo. As datas são os
        dias em que os pedidos foram feitos.
      </p>

      <form
        class="filters"
        aria-label="Filtros do histórico"
        (submit)="$event.preventDefault(); search()"
      >
        <div class="field">
          <label for="history-from">De</label>
          <input id="history-from" name="from" type="date" [(ngModel)]="from" />
        </div>
        <div class="field">
          <label for="history-to">Até</label>
          <input id="history-to" name="to" type="date" [(ngModel)]="to" />
        </div>
        <div class="field">
          <label for="history-status">Situação</label>
          <select id="history-status" name="status" [(ngModel)]="status">
            <option value="">Todas</option>
            @for (option of statuses; track option.id) {
              <option [value]="option.id">{{ option.label }}</option>
            }
          </select>
        </div>
        <div class="field">
          <label for="history-fulfillment">Modo</label>
          <select
            id="history-fulfillment"
            name="fulfillment"
            [(ngModel)]="fulfillment"
          >
            <option value="">Entrega e retirada</option>
            <option value="DELIVERY">Entrega</option>
            <option value="PICKUP">Retirada</option>
          </select>
        </div>
        <div class="field">
          <label for="history-number">Número</label>
          <input
            id="history-number"
            name="number"
            type="number"
            min="1"
            inputmode="numeric"
            [(ngModel)]="number"
          />
        </div>
        <div class="filter-actions">
          <button class="button" type="submit" [disabled]="loading()">
            Filtrar
          </button>
          <button
            class="button button--secondary"
            type="button"
            [disabled]="loading()"
            (click)="clear()"
          >
            Limpar
          </button>
        </div>
      </form>

      @if (error()) {
        <p class="status--error" role="alert">{{ error() }}</p>
      }
      @if (loading() && orders().length === 0) {
        <p role="status">Carregando histórico…</p>
      }
      @if (!loading() && loaded() && orders().length === 0 && !error()) {
        <p class="empty">Nenhum pedido encontrado com esses filtros.</p>
      }

      @if (orders().length > 0) {
        <div class="table-wrap">
          <table class="history-table">
            <caption class="visually-hidden">
              Pedidos encontrados
            </caption>
            <thead>
              <tr>
                <th scope="col">Pedido</th>
                <th scope="col">Data</th>
                <th scope="col">Cliente</th>
                <th scope="col">Modo</th>
                <th scope="col">Situação</th>
                <th scope="col" class="money">Total</th>
              </tr>
            </thead>
            <tbody>
              @for (order of orders(); track order.id) {
                <tr>
                  <th scope="row">
                    <button
                      class="button--link"
                      type="button"
                      (click)="open(order)"
                      [attr.aria-label]="
                        'Detalhes do pedido número ' + order.number
                      "
                    >
                      #{{ order.number }}
                    </button>
                    @if (order.openIncidents > 0) {
                      <span class="badge">
                        {{ order.openIncidents }} ocorrência(s) aberta(s)
                      </span>
                    }
                  </th>
                  <td>{{ order.placedAt | date: "dd/MM/yyyy HH:mm" }}</td>
                  <td>{{ order.customerName ?? "Cliente excluído" }}</td>
                  <td>{{ fulfillmentLabel(order.fulfillment) }}</td>
                  <td>{{ statusLabel(order.status) }}</td>
                  <td class="money">
                    {{ order.totalCents / 100 | currency: "BRL" }}
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
      @if (nextCursor() !== null) {
        <nav class="pagination" aria-label="Paginação do histórico">
          <button
            class="button button--secondary"
            type="button"
            [disabled]="loading()"
            (click)="loadMore()"
          >
            Carregar mais pedidos
          </button>
        </nav>
      }

      @if (selected(); as order) {
        <dialog
          #detailDialog
          class="detail"
          aria-modal="true"
          aria-labelledby="history-detail-title"
          (close)="close()"
        >
          <div class="detail-head">
            <h2 id="history-detail-title">Pedido #{{ order.number }}</h2>
            <button
              class="button button--secondary"
              type="button"
              autofocus
              (click)="close()"
            >
              Fechar
            </button>
          </div>
          <p>
            <strong>{{ statusLabel(order.status) }}</strong> ·
            {{ fulfillmentLabel(order.fulfillment) }} ·
            {{ paymentLabel(order.paymentMethod) }} ·
            {{ order.placedAt | date: "dd/MM/yyyy HH:mm" }}
          </p>
          <p>
            {{ order.customerName ?? "Cliente excluído" }}
            @if (order.customerPhone) {
              · {{ order.customerPhone }}
            }
          </p>
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
          <p>
            <strong>Total:</strong>
            {{ order.totalCents / 100 | currency: "BRL" }}
          </p>

          <h3>Transições</h3>
          @if (order.history.length === 0) {
            <p class="muted">Nenhuma transição registrada.</p>
          }
          <ol class="timeline">
            @for (change of order.history; track $index) {
              <li>
                {{ statusLabel(change.to) }} ·
                {{ change.at | date: "dd/MM/yyyy HH:mm:ss" }} ·
                {{ authorLabel(change) }}
                @if (change.reasonCode) {
                  · {{ reasonLabel(change.reasonCode) }}
                }
                @if (change.reasonText) {
                  — {{ change.reasonText }}
                }
              </li>
            }
          </ol>

          <h3>Ocorrências</h3>
          @if (detailError()) {
            <p class="status--error" role="alert">{{ detailError() }}</p>
          }
          @if (order.incidents.length === 0) {
            <p class="muted">Nenhuma ocorrência registrada.</p>
          }
          <ul class="incidents">
            @for (incident of order.incidents; track incident.id) {
              <li class="incident">
                <p>
                  <strong>{{ incidentTypeLabel(incident.type) }}</strong>
                  <span
                    class="badge"
                    [class.badge--done]="incident.status === 'RESOLVED'"
                  >
                    {{ incident.status === "OPEN" ? "Aberta" : "Resolvida" }}
                  </span>
                </p>
                <p>{{ incident.description }}</p>
                <p class="muted">
                  {{
                    incident.reportedBy === "CUSTOMER"
                      ? "Relatada pelo cliente"
                      : "Percebida pela equipe"
                  }}
                  · registrada por {{ incident.createdByName ?? "equipe" }} em
                  {{ incident.createdAt | date: "dd/MM/yyyy HH:mm" }}
                </p>
                @if (incident.status === "RESOLVED") {
                  <p class="muted">
                    Resolvida por {{ incident.resolvedByName ?? "equipe" }} em
                    {{ incident.resolvedAt | date: "dd/MM/yyyy HH:mm" }}
                    @if (incident.resolutionNote) {
                      — {{ incident.resolutionNote }}
                    }
                  </p>
                } @else {
                  <form
                    class="resolve-form"
                    (submit)="$event.preventDefault(); resolve(order, incident)"
                  >
                    <div class="field">
                      <label [for]="'resolution-' + incident.id"
                        >Como foi resolvida (opcional)</label
                      >
                      <input
                        [id]="'resolution-' + incident.id"
                        [name]="'resolution-' + incident.id"
                        [maxlength]="maxLength"
                        [(ngModel)]="resolutionNotes[incident.id]"
                      />
                    </div>
                    <button class="button" type="submit" [disabled]="saving()">
                      Marcar como resolvida
                    </button>
                  </form>
                }
              </li>
            }
          </ul>

          <form
            class="incident-form"
            aria-labelledby="incident-form-title"
            (submit)="$event.preventDefault(); report(order)"
          >
            <h4 id="incident-form-title">Registrar ocorrência</h4>
            <div class="field">
              <label for="incident-type">Tipo</label>
              <select
                id="incident-type"
                name="incidentType"
                [(ngModel)]="incidentType"
              >
                @for (type of incidentTypes; track type.id) {
                  <option [value]="type.id">{{ type.label }}</option>
                }
              </select>
            </div>
            <div class="field">
              <label for="incident-reporter">Quem relatou</label>
              <select
                id="incident-reporter"
                name="incidentReporter"
                [(ngModel)]="incidentReporter"
              >
                <option value="CUSTOMER">
                  O cliente, pelo contato da loja
                </option>
                <option value="STAFF">A equipe</option>
              </select>
            </div>
            <div class="field">
              <label for="incident-description">Descrição</label>
              <textarea
                id="incident-description"
                name="incidentDescription"
                rows="3"
                required
                [maxlength]="maxLength"
                aria-describedby="incident-hint"
                [(ngModel)]="incidentDescription"
              ></textarea>
              <small id="incident-hint" class="muted">
                Registro de atendimento: não muda o pedido nem gera reembolso.
                Evite dados pessoais que não ajudem a resolver.
              </small>
            </div>
            <button
              class="button"
              type="submit"
              [disabled]="saving() || !incidentDescription.trim()"
            >
              Registrar ocorrência
            </button>
          </form>
        </dialog>
      }
    </section>
  `,
  styles: `
    .filters {
      display: flex;
      flex-wrap: wrap;
      gap: var(--wo-spacing-3);
      align-items: end;
      margin: var(--wo-spacing-4) 0;
    }
    .filters .field {
      min-width: 150px;
    }
    .filters select,
    .incident-form select,
    .incident-form textarea {
      min-height: var(--wo-interaction-minimumTarget);
      font: inherit;
    }
    .filter-actions {
      display: flex;
      gap: var(--wo-spacing-2);
    }
    .table-wrap {
      overflow-x: auto;
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
    .history-table {
      width: 100%;
      border-collapse: collapse;
    }
    .history-table th,
    .history-table td {
      padding: var(--wo-spacing-2) var(--wo-spacing-3);
      border-bottom: 1px solid var(--wo-color-border);
      text-align: left;
      white-space: nowrap;
    }
    .history-table .money {
      text-align: right;
    }
    .badge {
      display: inline-block;
      margin-left: var(--wo-spacing-2);
      padding: 0 var(--wo-spacing-2);
      border-radius: var(--wo-radius-small);
      background: var(--wo-color-orangeSoft);
      font-size: 0.85rem;
      font-weight: normal;
    }
    .badge--done {
      background: var(--wo-color-surface);
      border: 1px solid var(--wo-color-border);
    }
    .empty {
      padding: var(--wo-spacing-4);
      text-align: center;
    }
    .pagination {
      display: flex;
      justify-content: center;
      margin-top: var(--wo-spacing-4);
    }
    .detail {
      position: fixed;
      z-index: 20;
      inset: 50% auto auto 50%;
      transform: translate(-50%, -50%);
      width: min(680px, calc(100vw - 32px));
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
    .detail-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--wo-spacing-4);
    }
    .items,
    .timeline {
      padding-left: 1.4rem;
    }
    .items li {
      display: flex;
      justify-content: space-between;
      gap: var(--wo-spacing-4);
      padding: var(--wo-spacing-2) 0;
      border-bottom: 1px solid var(--wo-color-border);
    }
    .items small {
      display: block;
      color: var(--wo-color-muted);
    }
    .incidents {
      display: grid;
      gap: var(--wo-spacing-3);
      padding: 0;
      list-style: none;
    }
    .incident {
      padding: var(--wo-spacing-3);
      border: 1px solid var(--wo-color-border);
      border-radius: var(--wo-radius-small);
      background: white;
    }
    .incident p {
      margin: 0 0 var(--wo-spacing-2);
    }
    .resolve-form,
    .incident-form {
      display: grid;
      gap: var(--wo-spacing-3);
    }
    .incident-form {
      margin-top: var(--wo-spacing-4);
      padding-top: var(--wo-spacing-4);
      border-top: 1px solid var(--wo-color-border);
    }
    .incident-form h4 {
      margin: 0;
    }
    @media (max-width: 800px) {
      .detail {
        padding: var(--wo-spacing-4);
      }
      .filters .field {
        min-width: 0;
        flex: 1 1 140px;
      }
    }
  `,
})
export class OrderHistoryPage {
  private readonly api = inject(OrderHistoryApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly detailDialog =
    viewChild<ElementRef<HTMLDialogElement>>("detailDialog");

  protected readonly statuses = (
    Object.entries(STATUS_LABELS) as [OrderStatus, string][]
  ).map(([id, label]) => ({ id, label }));
  protected readonly incidentTypes = INCIDENT_TYPES;
  protected readonly maxLength = INCIDENT_TEXT_MAX_LENGTH;

  protected from = "";
  protected to = "";
  protected status: OrderStatus | "" = "";
  protected fulfillment: "DELIVERY" | "PICKUP" | "" = "";
  protected number: number | null = null;

  protected readonly orders = signal<HistoryEntry[]>([]);
  protected readonly nextCursor = signal<number | null>(null);
  protected readonly loading = signal(false);
  protected readonly loaded = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly selected = signal<OrderDetail | null>(null);
  protected readonly detailError = signal<string | null>(null);
  protected readonly saving = signal(false);

  protected incidentType: IncidentType = "LATE_DELIVERY";
  protected incidentReporter: "CUSTOMER" | "STAFF" = "CUSTOMER";
  protected incidentDescription = "";
  protected resolutionNotes: Record<string, string> = {};

  /** Filters of the list on screen; "load more" keeps them even if the form changed. */
  private applied: HistoryFilters = {};
  /** Bumped by every search: a late page of an older search is dropped. */
  private generation = 0;
  private destroyed = false;

  constructor() {
    effect(() => {
      const shouldOpen = this.selected() !== null;
      const dialog = this.detailDialog()?.nativeElement;
      if (!dialog) return;
      if (shouldOpen && !dialog.open) dialog.showModal();
      else if (!shouldOpen && dialog.open) dialog.close();
    });
    this.destroyRef.onDestroy(() => (this.destroyed = true));
    void this.search();
  }

  protected async search(): Promise<void> {
    this.applied = {
      ...(this.from ? { from: this.from } : {}),
      ...(this.to ? { to: this.to } : {}),
      ...(this.status ? { status: this.status } : {}),
      ...(this.fulfillment ? { fulfillment: this.fulfillment } : {}),
      ...(this.number ? { number: this.number } : {}),
    };
    if (
      this.applied.from &&
      this.applied.to &&
      this.applied.from > this.applied.to
    ) {
      this.error.set("A data final precisa ser igual ou posterior à inicial.");
      return;
    }
    const generation = ++this.generation;
    this.orders.set([]);
    this.nextCursor.set(null);
    await this.fetch(generation);
  }

  protected clear(): void {
    this.from = "";
    this.to = "";
    this.status = "";
    this.fulfillment = "";
    this.number = null;
    void this.search();
  }

  protected loadMore(): Promise<void> {
    return this.fetch(this.generation, this.nextCursor() ?? undefined);
  }

  private async fetch(generation: number, cursor?: number): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const page = await this.api.history(this.applied, cursor);
      if (this.destroyed || generation !== this.generation) return;
      this.orders.update((orders) => [...orders, ...page.orders]);
      this.nextCursor.set(page.nextCursor);
      this.loaded.set(true);
    } catch (error) {
      if (this.destroyed || generation !== this.generation) return;
      this.error.set(
        apiStatus(error) === 422
          ? "Confira os filtros: datas válidas e número maior que zero."
          : errorMessage(error),
      );
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }

  protected async open(order: HistoryEntry): Promise<void> {
    this.detailError.set(null);
    try {
      const detail = await this.api.detail(order.id);
      if (!this.destroyed) this.selected.set(detail);
    } catch (error) {
      if (!this.destroyed) this.error.set(incidentError(error));
    }
  }

  protected close(): void {
    this.selected.set(null);
    this.detailError.set(null);
    this.incidentDescription = "";
    this.resolutionNotes = {};
  }

  protected async report(order: OrderDetail): Promise<void> {
    const description = this.incidentDescription.trim();
    if (!description) return;
    await this.save(order, () =>
      this.api.reportIncident(order.id, {
        type: this.incidentType,
        description,
        reportedBy: this.incidentReporter,
      }),
    );
    if (!this.detailError()) this.incidentDescription = "";
  }

  protected resolve(
    order: OrderDetail,
    incident: OrderIncident,
  ): Promise<void> {
    return this.save(order, () =>
      this.api.resolveIncident(
        order.id,
        incident.id,
        this.resolutionNotes[incident.id] ?? "",
      ),
    );
  }

  /** Runs one incident write, then reloads the detail and the open-incident count of the row. */
  private async save(
    order: OrderDetail,
    write: () => Promise<OrderIncident>,
  ): Promise<void> {
    this.saving.set(true);
    this.detailError.set(null);
    try {
      await write();
    } catch (error) {
      if (!this.destroyed) this.detailError.set(incidentError(error));
    }
    try {
      const detail = await this.api.detail(order.id);
      if (this.destroyed || this.selected()?.id !== order.id) return;
      this.selected.set(detail);
      const open = detail.incidents.filter((i) => i.status === "OPEN").length;
      this.orders.update((orders) =>
        orders.map((entry) =>
          entry.id === order.id ? { ...entry, openIncidents: open } : entry,
        ),
      );
    } catch (error) {
      if (!this.destroyed && !this.detailError())
        this.detailError.set(incidentError(error));
    } finally {
      this.saving.set(false);
    }
  }

  protected statusLabel(status: OrderStatus): string {
    return STATUS_LABELS[status] ?? status;
  }
  protected fulfillmentLabel(fulfillment: string): string {
    return FULFILLMENT_LABELS[fulfillment] ?? fulfillment;
  }
  protected paymentLabel(method: string): string {
    return PAYMENT_LABELS[method] ?? method;
  }
  protected reasonLabel(code: string): string {
    return REASON_LABELS[code] ?? code;
  }
  protected incidentTypeLabel(type: string): string {
    return INCIDENT_TYPES.find((option) => option.id === type)?.label ?? type;
  }
  protected authorLabel(change: OrderDetail["history"][number]): string {
    if (change.actorType === "CUSTOMER") return "pelo cliente";
    if (change.actorType === "SYSTEM") return "automático";
    return change.actorName ? `por ${change.actorName}` : "pela equipe";
  }
  protected itemName = itemName;
  protected itemDetails = itemDetails;
}
