import {
  computed,
  DestroyRef,
  inject,
  Injectable,
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
  private end?: () => void;
  private starting = false;
  private disposed = false;
  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.disposed = true;
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
          const records = await browserRecords(slug);
          try {
            if (this.disposed) return;
            const model = createCommerceModel({
              client: createCustomerClient({
                apiUrl: "",
                storeSlug: slug,
                fetch: globalThis.fetch.bind(globalThis),
                secret: records.secret,
              }),
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
            } finally {
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
