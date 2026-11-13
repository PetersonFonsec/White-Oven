import {
  type Answer,
  type PublicGetOptions,
  publicGet,
} from "../brand/store-loader.ts";

import { parseMenu, type PublicMenu } from "@whiteoven/customer-core/menu/menu";
export * from "@whiteoven/customer-core/menu/menu";

/** The menu is not cached: prices change, and an order is priced again by the API anyway. */
export function loadMenu(
  options: PublicGetOptions,
): Promise<Answer<PublicMenu>> {
  return publicGet(options, "/menu", parseMenu);
}
