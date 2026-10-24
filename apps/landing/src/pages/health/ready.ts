import type { APIRoute } from "astro";
import { healthResponse } from "../../server/health";
export const prerender = false;
export const GET: APIRoute = () => healthResponse(false);
