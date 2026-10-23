import type { APIRoute } from "astro";
import { getCaptureConfig } from "../../server/config";
import { SqliteLeadStore } from "../../server/lead-store";
import { createLeadHandler } from "../../server/lead-handler";
export const prerender = false;
let store: SqliteLeadStore | undefined;
const handler = createLeadHandler(
  getCaptureConfig,
  () => (store ??= new SqliteLeadStore(getCaptureConfig().databasePath)),
);
export const ALL: APIRoute = ({ request }) => handler(request);
