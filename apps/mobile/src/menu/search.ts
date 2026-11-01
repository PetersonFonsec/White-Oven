import type { MenuSection } from "./menu.ts";

/** Lower case without accents, so "calabresa" finds "Calabresa" and "acai" finds "Açaí". */
export function searchKey(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLocaleLowerCase("pt-BR")
    .trim();
}

/**
 * The menu as the customer filtered it: one category (or `all`) and a query over names and
 * pizza descriptions. Only shapes the local view; empty sections are left out.
 */
export function filterMenu(
  sections: MenuSection[],
  category: string,
  query: string,
): MenuSection[] {
  const key = searchKey(query);
  return sections
    .filter((section) => category === "all" || section.id === category)
    .map((section) => ({
      ...section,
      items: section.items.filter(
        (item) =>
          !key ||
          searchKey(item.name).includes(key) ||
          (item.kind === "PIZZA" &&
            !!item.description &&
            searchKey(item.description).includes(key)),
      ),
    }))
    .filter((section) => section.items.length > 0);
}
