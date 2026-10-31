import { BadRequestException, Controller, Get, Query } from "@nestjs/common";
import { z } from "zod";
import { CatalogService } from "./catalog.service.ts";

const catalogQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(500),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).max(200).optional(),
  scope: z.enum(["required", "additional", "component"]).optional(),
});

@Controller("api")
export class CatalogController {
  constructor(private readonly catalog: CatalogService) {}

  @Get("catalog/summary")
  summary() {
    return this.catalog.summary();
  }

  @Get("products")
  products(@Query() rawQuery: Record<string, unknown>) {
    const parsed = catalogQuerySchema.safeParse(rawQuery);

    if (!parsed.success) {
      throw new BadRequestException(parsed.error.flatten());
    }

    return this.catalog.products(parsed.data);
  }
}
