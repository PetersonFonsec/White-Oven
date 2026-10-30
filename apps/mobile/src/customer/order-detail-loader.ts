/** One cancellable detail request at a time; a new order supersedes the previous request. */
export function createOrderDetailLoader<T>(options: {
  load: (orderId: string, signal: AbortSignal) => Promise<T>;
  onStart: (orderId: string) => void;
  onSuccess: (orderId: string, value: T) => void;
  onError: (orderId: string, error: unknown) => void;
  onSettled: (orderId: string) => void;
}) {
  let active: { orderId: string; controller: AbortController } | null = null;

  function cancel(orderId?: string) {
    if (!active || (orderId && active.orderId !== orderId)) return;
    active.controller.abort();
    active = null;
  }

  async function load(orderId: string): Promise<void> {
    if (active?.orderId === orderId) return;
    cancel();
    const request = { orderId, controller: new AbortController() };
    active = request;
    options.onStart(orderId);
    try {
      const value = await options.load(orderId, request.controller.signal);
      if (active === request && !request.controller.signal.aborted)
        options.onSuccess(orderId, value);
    } catch (error) {
      if (active === request && !request.controller.signal.aborted)
        options.onError(orderId, error);
    } finally {
      if (active === request) {
        active = null;
        options.onSettled(orderId);
      }
    }
  }

  return {
    load,
    cancel,
    isLoading(orderId: string) {
      return active?.orderId === orderId;
    },
  };
}
