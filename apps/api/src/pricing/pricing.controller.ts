import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { z } from "zod";
import { PricingService } from "./pricing.service.ts";

const comparisonQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
  q: z.string().trim().min(1).max(200).optional(),
  scope: z.enum(["required", "additional", "component"]).optional(),
});
const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
const productIdSchema = z.string().uuid();
const decimalInput = z
  .union([z.string(), z.number().finite()])
  .transform((value) => String(value).trim().replace(",", "."));
const manualObservationSchema = z.object({
  offerId: z.string().uuid(),
  rawPrice: decimalInput.pipe(
    z
      .string()
      .regex(/^\d{1,12}(?:\.\d{1,2})?$/)
      .refine((value) => Number(value) > 0, "Price must be positive"),
  ),
  quantity: decimalInput
    .pipe(
      z
        .string()
        .regex(/^\d{1,8}(?:\.\d{1,4})?$/)
        .refine((value) => Number(value) > 0, "Quantity must be positive"),
    )
    .default("1"),
  unit: z.string().trim().min(1).max(32).default("piece"),
  currency: z
    .string()
    .trim()
    .length(3)
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/))
    .default("RUB"),
  priceType: z.enum(["rrp", "retail", "sale", "quote", "unknown"]).default("retail"),
  isFromPrice: z.boolean().default(false),
  isStale: z.boolean().default(false),
  packageHomogeneous: z.boolean().default(true),
  vatIncluded: z.boolean().optional(),
  stockStatus: z.string().trim().min(1).max(100).optional(),
  region: z.string().trim().min(1).max(200).optional(),
  deliveryIncluded: z.boolean().optional(),
  installationIncluded: z.boolean().optional(),
  observedAt: z.string().datetime({ offset: true }).optional(),
  evidenceText: z.string().trim().min(1).max(1000).optional(),
  comment: z.string().trim().min(1).max(1000).optional(),
});

@Controller("api")
export class PricingController {
  constructor(private readonly pricing: PricingService) {}

  @Get("export.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Content-Disposition", 'attachment; filename="competitor-prices.csv"')
  exportCsv() {
    return this.pricing.exportCsv();
  }

  @Get("comparisons")
  comparisons(@Query() rawQuery: Record<string, unknown>) {
    const parsed = comparisonQuerySchema.safeParse(rawQuery);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.pricing.comparisons(parsed.data);
  }

  @Get("products/:productId/history")
  history(
    @Param("productId") rawProductId: string,
    @Query() rawQuery: Record<string, unknown>,
  ) {
    const productId = productIdSchema.safeParse(rawProductId);
    const query = historyQuerySchema.safeParse(rawQuery);
    if (!productId.success || !query.success) {
      throw new BadRequestException("Invalid product history request");
    }
    return this.pricing.history(productId.data, query.data);
  }

  @Post("manual-observations")
  @HttpCode(201)
  addManualObservation(@Body() rawBody: unknown) {
    const parsed = manualObservationSchema.safeParse(rawBody);
    if (!parsed.success) throw new BadRequestException(parsed.error.flatten());
    return this.pricing.addManualObservation(parsed.data);
  }
}
