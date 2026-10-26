import { Module } from "@nestjs/common";
import {
  IMAGE_PROCESSOR,
  IMAGE_STORAGE,
  LocalImageStorage,
  processImage,
} from "./image-storage";
import { CatalogModule } from "../catalog/catalog.module";
import { ImageController, PublicImageController } from "./image.controller";
import { ImageService } from "./image.service";

@Module({
  imports: [CatalogModule],
  controllers: [ImageController, PublicImageController],
  providers: [
    ImageService,
    LocalImageStorage,
    { provide: IMAGE_STORAGE, useExisting: LocalImageStorage },
    { provide: IMAGE_PROCESSOR, useValue: processImage },
  ],
})
export class ImageModule {}
