/** Session generation fence for customer-owned order data. */
export function createOrderSessionFence<Model extends object>() {
  let model: Model | null = null;
  let customerId: string | null = null;
  let initialized = false;
  let alive = true;
  let generation = 0;

  return {
    activate() {
      alive = true;
    },
    update(identityModel: Model, identityCustomerId: string | null) {
      const changed =
        !initialized ||
        model !== identityModel ||
        customerId !== identityCustomerId;
      if (changed) {
        initialized = true;
        model = identityModel;
        customerId = identityCustomerId;
        generation++;
      }
      return { generation, changed };
    },
    currentGeneration() {
      return generation;
    },
    isIdentity(identityModel: Model, identityCustomerId: string | null) {
      return (
        alive &&
        model === identityModel &&
        customerId !== null &&
        customerId === identityCustomerId
      );
    },
    isCurrent(requestGeneration: number) {
      return alive && generation === requestGeneration;
    },
    dispose() {
      alive = false;
      generation++;
    },
  };
}

/** Order list requests are replaceable and scoped to one session generation. */
export function createCustomerOrderListLoader<T>(options: {
  load: (cursor: number | null, signal: AbortSignal) => Promise<T>;
  onStart: (generation: number) => void;
  onSuccess: (generation: number, value: T, replace: boolean) => void;
  onError: (generation: number, error: unknown) => void;
  onSettled: (generation: number) => void;
}) {
  let active: {
    generation: number;
    controller: AbortController;
  } | null = null;

  function cancel() {
    active?.controller.abort();
    active = null;
  }

  async function load(
    cursor: number | null,
    replace: boolean,
    generation: number,
  ): Promise<void> {
    cancel();
    const request = { generation, controller: new AbortController() };
    active = request;
    options.onStart(generation);
    try {
      const value = await options.load(cursor, request.controller.signal);
      if (active === request && !request.controller.signal.aborted)
        options.onSuccess(generation, value, replace);
    } catch (error) {
      if (active === request && !request.controller.signal.aborted)
        options.onError(generation, error);
    } finally {
      if (active === request) {
        active = null;
        options.onSettled(generation);
      }
    }
  }

  return { load, cancel };
}

/** One cancellable detail request at a time; a new order or session supersedes the previous request. */
export function createOrderDetailLoader<T>(options: {
  load: (orderId: string, signal: AbortSignal) => Promise<T>;
  onStart: (orderId: string, generation: number) => void;
  onSuccess: (orderId: string, generation: number, value: T) => void;
  onError: (orderId: string, generation: number, error: unknown) => void;
  onSettled: (orderId: string, generation: number) => void;
}) {
  let active: {
    orderId: string;
    generation: number;
    controller: AbortController;
  } | null = null;

  function cancel(orderId?: string) {
    if (!active || (orderId && active.orderId !== orderId)) return;
    active.controller.abort();
    active = null;
  }

  async function load(orderId: string, generation = 0): Promise<void> {
    if (active?.orderId === orderId && active.generation === generation) return;
    cancel();
    const request = { orderId, generation, controller: new AbortController() };
    active = request;
    options.onStart(orderId, generation);
    try {
      const value = await options.load(orderId, request.controller.signal);
      if (active === request && !request.controller.signal.aborted)
        options.onSuccess(orderId, generation, value);
    } catch (error) {
      if (active === request && !request.controller.signal.aborted)
        options.onError(orderId, generation, error);
    } finally {
      if (active === request) {
        active = null;
        options.onSettled(orderId, generation);
      }
    }
  }

  return {
    load,
    cancel,
    isLoading(orderId: string, generation = 0) {
      return active?.orderId === orderId && active.generation === generation;
    },
  };
}
