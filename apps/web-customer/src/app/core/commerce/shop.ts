import {
  computed,
  DestroyRef,
  inject,
  Injectable,
  InjectionToken,
  signal,
} from "@angular/core";
import {
  createCommerceModel,
  type CommerceModel,
  type CommerceState,
} from "@whiteoven/customer-core/cart/model";
import { cartUnits } from "@whiteoven/customer-core/cart/cart";
import { createCustomerClient } from "@whiteoven/customer-core/customer/client";
import { browserRecords } from "./browser-record";
import { validSlug } from "../api/public-api";

export const OPEN_SHOP_RECORDS = new InjectionToken(
  "Open encrypted shop records",
  { factory: () => browserRecords },
);

@Injectable()
export class Shop {
  readonly state = signal<CommerceState | null>(null);
  readonly problem = signal("");
  readonly units = computed(() => {
    const state = this.state();
    if (
      !state ||
      (state.pending && state.pending.customerId !== state.profile?.id)
    )
      return 0;
    return cartUnits(state.cart);
  });
  readonly locked = computed(
    () =>
      !this.state()?.ready || !!this.state()?.busy || !!this.state()?.pending,
  );
  model: CommerceModel | null = null;
  private readonly openRecords = inject(OPEN_SHOP_RECORDS);
  private end?: () => void;
  private starting = false;
  private disposed = false;
  private readonly shutdown = new AbortController();
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
      this.model = null;
      this.shutdown.abort();
      this.end?.();
    });
  }
  async start(slug: string) {
    if (this.starting || this.disposed || !validSlug(slug)) return;
    this.starting = true;
    this.problem.set("");
    try {
      await navigator.locks.request(
        "whiteoven-shop/" + slug,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            this.problem.set(
              "A sacola desta loja está aberta em outra aba. Feche a outra aba e tente novamente.",
            );
            return;
          }
          if (this.disposed) return;
          const records = await this.openRecords(slug);
          try {
            if (this.disposed) return;
            const client = createCustomerClient({
              apiUrl: "",
              storeSlug: slug,
              fetch: (url, init) =>
                fetch(url, {
                  ...init,
                  signal: init?.signal
                    ? AbortSignal.any([init.signal, this.shutdown.signal])
                    : this.shutdown.signal,
                }),
              secret: records.secret,
            });
            // Order reads run outside the model's busy section and can rotate a token.
            const active = new Set<Promise<unknown>>();
            const request = client.request;
            client.request = (...args) => {
              this.shutdown.signal.throwIfAborted();
              const result = request(...args).finally(() =>
                active.delete(result),
              );
              active.add(result);
              return result;
            };
            const model = createCommerceModel({
              client,
              storage: records.storage,
              uuid: () => crypto.randomUUID(),
            });
            this.model = model;
            const sync = () => {
              if (!this.disposed) this.state.set(model.getSnapshot());
            };
            const stop = model.subscribe(sync);
            sync();
            try {
              const lifetime = new Promise<void>(
                (resolve) => (this.end = resolve),
              );
              await model.init();
              await lifetime;
              if (model.getSnapshot().busy)
                await new Promise<void>((resolve) => {
                  const unsubscribe = model.subscribe(() => {
                    if (!model.getSnapshot().busy) {
                      unsubscribe();
                      resolve();
                    }
                  });
                });
              await Promise.allSettled(active);
            } finally {
              this.end = undefined;
              stop();
              this.model = null;
            }
          } finally {
            records.close();
          }
        },
      );
    } catch {
      if (!this.disposed)
        this.problem.set(
          "Não foi possível abrir a sacola com segurança neste navegador. Confira as permissões de armazenamento.",
        );
    } finally {
      this.starting = false;
    }
  }
}
