import { Module } from "@nestjs/common";
import { IMAGE_STORAGE, LocalImageStorage } from "./image-storage";
import { ImageController } from "./image.controller";
import { ImageService } from "./image.service";

@Module({
  controllers: [ImageController],
  providers: [
    ImageService,
    LocalImageStorage,
    { provide: IMAGE_STORAGE, useExisting: LocalImageStorage },
  ],
})
export class ImageModule {}
