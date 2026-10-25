export interface CatalogCategoryBody {
  name: string;
  kind: "PIZZA" | "PRODUCT";
  sortOrder?: number;
}
export interface CatalogSizeBody {
  name: string;
  slices: number;
  maxFlavors: 1 | 2;
  sortOrder?: number;
}
export interface CatalogIngredientBody {
  name: string;
  removable?: boolean;
}
export interface CatalogFlavorBody {
  categoryId: string;
  name: string;
  description?: string | null;
  ingredientIds?: string[];
}
export interface CatalogNamedItemBody {
  name: string;
}
export interface CatalogSimpleProductBody {
  categoryId: string;
  name: string;
  priceCents: number;
}
export interface CatalogPricingPolicyBody {
  halfAndHalfStrategy: "HIGHEST" | "AVERAGE";
  halfAndHalfSurchargeCents: number;
  maxExtrasPerHalf: number;
}
