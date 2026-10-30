import {
  EXPO_BATCH_SIZE,
  type PushMessage,
  PushRequestError,
  type PushTicket,
  parseExpoTickets,
} from "./push-rules";

/**
 * Sends one request of at most `EXPO_BATCH_SIZE` messages: one ticket per message, in order.
 * Throws `PushRequestError` when the request as a whole failed and may be tried again.
 */
export interface PushSender {
  send(messages: readonly PushMessage[]): Promise<PushTicket[]>;
}

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const EXPO_TIMEOUT_MS = 10_000;

/** Expo Push HTTP API (Q-11). Tokens and texts never reach the logs. */
export class ExpoPushSender implements PushSender {
  constructor(
    private readonly accessToken: string | null,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(messages: readonly PushMessage[]): Promise<PushTicket[]> {
    if (messages.length > EXPO_BATCH_SIZE)
      throw new Error(`at most ${EXPO_BATCH_SIZE} messages per request`);
    let response: Response;
    try {
      response = await this.fetchFn(EXPO_PUSH_URL, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(EXPO_TIMEOUT_MS),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          ...(this.accessToken
            ? { Authorization: `Bearer ${this.accessToken}` }
            : {}),
        },
        body: JSON.stringify(
          messages.map((message) => ({
            ...message,
            sound: "default",
            ttl: 30 * 60,
          })),
        ),
      });
    } catch {
      throw new PushRequestError("Expo request failed");
    }
    if (!response.ok)
      throw new PushRequestError(`Expo answered ${response.status}`);
    const body: unknown = await response.json().catch(() => null);
    return parseExpoTickets(body, messages.length);
  }
}
