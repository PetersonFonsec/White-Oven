import { Migration } from "@mikro-orm/migrations";

/** Attach private, tenant-owned M2.5 image assets to pizza flavors and simple products. */
export class Migration20261024090000_catalog_images extends Migration {
  override up(): void {
    this.addSql(`
      alter table catalog_flavors add column image_asset_id uuid;
      alter table catalog_flavors add constraint catalog_flavors_image_asset_fk
        foreign key (tenant_id,image_asset_id) references image_assets(tenant_id,id);
      alter table catalog_simple_products add column image_asset_id uuid;
      alter table catalog_simple_products add constraint catalog_simple_products_image_asset_fk
        foreign key (tenant_id,image_asset_id) references image_assets(tenant_id,id);
    `);
  }

  override down(): void {
    throw new Error("Migration20261024090000_catalog_images is forward-only");
  }
}
