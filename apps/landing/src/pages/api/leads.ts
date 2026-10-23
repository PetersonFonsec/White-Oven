import type { APIRoute } from "astro";
import { getCaptureConfig } from "../../server/config";
import { SqliteLeadStore } from "../../server/lead-store";
import { createLeadHandler } from "../../server/lead-handler";
import { getRequestClient } from "../../server/request-context";
export const prerender = false;
let store: SqliteLeadStore | undefined;
const handler = createLeadHandler(
  () => {
    const config = getCaptureConfig();
    return {
      ...config,
      enabled:
        config.enabled && (import.meta.env.DEV || Boolean(getRequestClient())),
    };
  },
  () => (store ??= new SqliteLeadStore(getCaptureConfig().databasePath)),
);
export const ALL: APIRoute = ({ request }) =>
  handler(request, getRequestClient() ?? "development");
