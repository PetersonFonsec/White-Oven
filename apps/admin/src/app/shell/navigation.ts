import type { Role } from "../core/session";

export interface StoreSection {
  path: string;
  label: string;
  roles: readonly Role[];
}

/**
 * Store sections by role. Routes use the same lists, and the API enforces its own: hiding a link
 * is convenience, never the protection.
 */
export const STORE_SECTIONS: readonly StoreSection[] = [
  { path: "", label: "Início", roles: ["OWNER", "MANAGER", "STAFF"] },
  { path: "cardapio", label: "Cardápio", roles: ["OWNER", "MANAGER"] },
  { path: "configuracoes", label: "Configurações", roles: ["OWNER"] },
  { path: "equipe", label: "Equipe", roles: ["OWNER"] },
];

export const rolesOf = (path: string): readonly Role[] =>
  STORE_SECTIONS.find((section) => section.path === path)!.roles;
