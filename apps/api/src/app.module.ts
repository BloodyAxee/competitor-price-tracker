import { Module } from "@nestjs/common";
import { CatalogController } from "./catalog/catalog.controller.ts";
import { CatalogService } from "./catalog/catalog.service.ts";
import { PrismaService } from "./database/prisma.service.ts";
import { HealthController } from "./health.controller.ts";

@Module({
  controllers: [HealthController, CatalogController],
  providers: [PrismaService, CatalogService],
})
export class AppModule {}
