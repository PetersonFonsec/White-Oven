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
