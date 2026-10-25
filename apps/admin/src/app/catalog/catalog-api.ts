import { HttpClient, HttpHeaders } from "@angular/common/http";
import { Injectable, inject } from "@angular/core";
import { firstValueFrom } from "rxjs";

const CATALOG = "/v1/admin/catalog";
const IMAGES = `${CATALOG}/images`;

export interface CatalogCategory {
  id: string;
  name: string;
  kind: "PIZZA" | "PRODUCT";
  sortOrder: number;
  archived: boolean;
}
export interface CatalogSize {
  id: string;
  name: string;
  slices: number;
  maxFlavors: 1 | 2;
  sortOrder: number;
  available: boolean;
  archived: boolean;
}
export interface CatalogIngredient {
  id: string;
  name: string;
  removable: boolean;
  archived: boolean;
}
export interface CatalogFlavor {
  id: string;
  categoryId: string;
  name: string;
  description: string | null;
  ingredientIds: string[];
  imageId: string | null;
  available: boolean;
  archived: boolean;
}
export interface FlavorPrice {
  flavorId: string;
  sizeId: string;
  priceCents: number;
}
export interface CatalogCrust {
  id: string;
  name: string;
  imageId?: string | null;
  available: boolean;
  archived: boolean;
}
export interface CrustPrice {
  crustId: string;
  sizeId: string;
  priceCents: number;
}
export interface CatalogExtra {
  id: string;
  name: string;
  available: boolean;
  archived: boolean;
}
export interface ExtraPrice {
  extraId: string;
  sizeId: string;
  wholePriceCents: number;
  halfPriceCents: number;
}
export interface CatalogProduct {
  id: string;
  categoryId: string;
  name: string;
  priceCents: number;
  imageId: string | null;
  available: boolean;
  archived: boolean;
}
export interface CatalogPolicy {
  halfAndHalfStrategy: "HIGHEST" | "AVERAGE";
  halfAndHalfSurchargeCents: number;
  maxExtrasPerHalf: number;
}
export interface CatalogSnapshot {
  categories: CatalogCategory[];
  sizes: CatalogSize[];
  ingredients: CatalogIngredient[];
  flavors: CatalogFlavor[];
  flavorPrices: FlavorPrice[];
  crusts: CatalogCrust[];
  crustPrices: CrustPrice[];
  extras: CatalogExtra[];
  extraPrices: ExtraPrice[];
  simpleProducts: CatalogProduct[];
  pricingPolicy: CatalogPolicy | null;
}
export interface StoredCatalogImage {
  id: string;
  width: number;
  height: number;
  sourceFormat: "jpeg" | "png" | "webp";
  variants: { thumbnail: string; menu: string };
}

@Injectable({ providedIn: "root" })
export class CatalogApi {
  private readonly http = inject(HttpClient);

  snapshot(): Promise<CatalogSnapshot> {
    return firstValueFrom(this.http.get<CatalogSnapshot>(`${CATALOG}/items`));
  }

  create(path: string, body: object): Promise<{ id: string }> {
    return firstValueFrom(
      this.http.post<{ id: string }>(`${CATALOG}/${path}`, body),
    );
  }

  update(path: string, id: string, body: object): Promise<{ id: string }> {
    return firstValueFrom(
      this.http.patch<{ id: string }>(
        `${CATALOG}/${path}/${encodeURIComponent(id)}`,
        body,
      ),
    );
  }

  archive(path: string, id: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(`${CATALOG}/${path}/${encodeURIComponent(id)}`),
    );
  }

  availability(
    kind: "flavors" | "crusts" | "extras" | "products",
    id: string,
    available: boolean,
  ): Promise<unknown> {
    return firstValueFrom(
      this.http.patch(`${CATALOG}/availability/${kind}/${encodeURIComponent(id)}`, {
        available,
      }),
    );
  }

  setFlavorPrice(
    flavorId: string,
    sizeId: string,
    priceCents: number,
  ): Promise<unknown> {
    return firstValueFrom(
      this.http.put(
        `${CATALOG}/flavors/${encodeURIComponent(flavorId)}/prices/${encodeURIComponent(sizeId)}`,
        { priceCents },
      ),
    );
  }

  removeFlavorPrice(flavorId: string, sizeId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(
        `${CATALOG}/flavors/${encodeURIComponent(flavorId)}/prices/${encodeURIComponent(sizeId)}`,
      ),
    );
  }

  setCrustPrice(
    crustId: string,
    sizeId: string,
    priceCents: number,
  ): Promise<unknown> {
    return firstValueFrom(
      this.http.put(
        `${CATALOG}/crusts/${encodeURIComponent(crustId)}/prices/${encodeURIComponent(sizeId)}`,
        { priceCents },
      ),
    );
  }

  removeCrustPrice(crustId: string, sizeId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(
        `${CATALOG}/crusts/${encodeURIComponent(crustId)}/prices/${encodeURIComponent(sizeId)}`,
      ),
    );
  }

  setExtraPrice(
    extraId: string,
    sizeId: string,
    wholePriceCents: number,
    halfPriceCents: number,
  ): Promise<unknown> {
    return firstValueFrom(
      this.http.put(
        `${CATALOG}/extras/${encodeURIComponent(extraId)}/prices/${encodeURIComponent(sizeId)}`,
        { wholePriceCents, halfPriceCents },
      ),
    );
  }

  removeExtraPrice(extraId: string, sizeId: string): Promise<void> {
    return firstValueFrom(
      this.http.delete<void>(
        `${CATALOG}/extras/${encodeURIComponent(extraId)}/prices/${encodeURIComponent(sizeId)}`,
      ),
    );
  }

  uploadImage(file: File): Promise<StoredCatalogImage> {
    return firstValueFrom(
      this.http.post<StoredCatalogImage>(IMAGES, file, {
        headers: new HttpHeaders({ "Content-Type": file.type }),
      }),
    );
  }

  readImage(id: string, variant: "thumbnail" | "menu" = "thumbnail"): Promise<Blob> {
    return firstValueFrom(
      this.http.get(`${IMAGES}/${encodeURIComponent(id)}/${variant}`, {
        responseType: "blob",
      }),
    );
  }
}
