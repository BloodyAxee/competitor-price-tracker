import { Module } from "@nestjs/common";
import { CatalogController } from "./catalog/catalog.controller.ts";
import { CatalogService } from "./catalog/catalog.service.ts";
import { CollectionController } from "./collection/collection.controller.ts";
import { CollectionSchedulerService } from "./collection/collection-scheduler.service.ts";
import { CollectionService } from "./collection/collection.service.ts";
import { PrismaService } from "./database/prisma.service.ts";
import { HealthController } from "./health.controller.ts";
import { PricingController } from "./pricing/pricing.controller.ts";
import { PricingService } from "./pricing/pricing.service.ts";

@Module({
  controllers: [HealthController, CatalogController, CollectionController, PricingController],
  providers: [
    PrismaService,
    CatalogService,
    CollectionService,
    CollectionSchedulerService,
    PricingService,
  ],
})
export class AppModule {}
