import { Injectable } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.ts";
import { PrismaService } from "../database/prisma.service.ts";

export interface CatalogQuery {
  limit: number;
  offset: number;
  q?: string;
  scope?: "required" | "additional" | "component";
}

@Injectable()
export class CatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async summary() {
    const [total, required, additional, ownUrls, exactOffers, reviewOffers] =
      await Promise.all([
        this.prisma.product.count({ where: { isActive: true } }),
        this.prisma.product.count({ where: { isActive: true, catalogScope: "required" } }),
        this.prisma.product.count({ where: { isActive: true, catalogScope: "additional" } }),
        this.prisma.product.count({ where: { isActive: true, ownUrl: { not: null } } }),
        this.prisma.offer.count({ where: { isActive: true, matchStatus: "exact" } }),
        this.prisma.offer.count({ where: { isActive: true, matchStatus: "review" } }),
      ]);

    return { total, required, additional, ownUrls, exactOffers, reviewOffers };
  }

  async products(query: CatalogQuery) {
    const where: Prisma.ProductWhereInput = {
      isActive: true,
      ...(query.scope ? { catalogScope: query.scope } : {}),
      ...(query.q
        ? {
            OR: [
              { name: { contains: query.q, mode: "insensitive" } },
              { article: { contains: query.q, mode: "insensitive" } },
            ],
          }
        : {}),
    };

    const [total, items] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: [{ priority: "asc" }, { name: "asc" }],
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          externalKey: true,
          name: true,
          brand: true,
          article: true,
          ownUrl: true,
          catalogScope: true,
          priority: true,
          offers: {
            where: { isActive: true },
            orderBy: [{ matchStatus: "asc" }, { createdAt: "asc" }],
            select: {
              id: true,
              competitorUrl: true,
              sellerArticle: true,
              matchStatus: true,
              matchReason: true,
              seller: { select: { displayName: true } },
              source: {
                select: {
                  name: true,
                  sourceType: true,
                  officialStatus: true,
                },
              },
            },
          },
          bundleParts: {
            orderBy: { componentProduct: { name: "asc" } },
            select: {
              quantity: true,
              componentProduct: {
                select: { id: true, name: true, article: true },
              },
            },
          },
        },
      }),
    ]);

    return { total, items, limit: query.limit, offset: query.offset };
  }
}
