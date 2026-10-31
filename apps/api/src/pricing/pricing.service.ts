import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.ts";
import { PrismaService } from "../database/prisma.service.ts";
import { evaluateManualPrice, type ManualPriceType } from "./manual-price.ts";

export interface ComparisonQuery {
  limit: number;
  offset: number;
  q?: string;
  scope?: "required" | "additional" | "component";
}

export interface HistoryQuery {
  limit: number;
  offset: number;
}

export interface ManualObservationInput {
  offerId: string;
  rawPrice: string;
  quantity: string;
  unit: string;
  currency: string;
  priceType: ManualPriceType;
  isFromPrice: boolean;
  isStale: boolean;
  packageHomogeneous: boolean;
  vatIncluded?: boolean;
  stockStatus?: string;
  region?: string;
  deliveryIncluded?: boolean;
  installationIncluded?: boolean;
  observedAt?: string;
  evidenceText?: string;
  comment?: string;
}

function priceDto(observation: {
  id: bigint;
  rawPrice: { toString(): string } | null;
  normalizedPrice: { toString(): string } | null;
  currency: string;
  unit: string | null;
  priceType: string;
  vatIncluded: boolean | null;
  stockStatus: string | null;
  region: string | null;
  deliveryIncluded: boolean | null;
  installationIncluded: boolean | null;
  observedAt: Date | null;
  receivedAt: Date;
  method: string;
  reliability: string;
  exclusionReason: string | null;
  evidenceText: string | null;
}) {
  return {
    id: observation.id.toString(),
    rawPrice: observation.rawPrice?.toString() ?? null,
    normalizedPrice: observation.normalizedPrice?.toString() ?? null,
    currency: observation.currency.trim(),
    unit: observation.unit,
    priceType: observation.priceType,
    vatIncluded: observation.vatIncluded,
    stockStatus: observation.stockStatus,
    region: observation.region,
    deliveryIncluded: observation.deliveryIncluded,
    installationIncluded: observation.installationIncluded,
    observedAt: observation.observedAt,
    receivedAt: observation.receivedAt,
    method: observation.method,
    reliability: observation.reliability,
    exclusionReason: observation.exclusionReason,
    evidenceText: observation.evidenceText,
  };
}

function comparisonDelta(ownPrice: string | null, competitorPrice: string | null) {
  if (!ownPrice || !competitorPrice) return { amount: null, percent: null };
  const own = Number(ownPrice);
  const competitor = Number(competitorPrice);
  if (!Number.isFinite(own) || !Number.isFinite(competitor) || own === 0) {
    return { amount: null, percent: null };
  }
  return {
    amount: (competitor - own).toFixed(2),
    percent: (((competitor - own) / own) * 100).toFixed(2),
  };
}

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  async comparisons(query: ComparisonQuery) {
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
    const [total, products] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: [{ priority: "asc" }, { name: "asc" }],
        skip: query.offset,
        take: query.limit,
        include: {
          offers: {
            where: { isActive: true, matchStatus: "exact", source: { isActive: true } },
            orderBy: [{ createdAt: "asc" }],
            include: {
              seller: { select: { displayName: true } },
              source: {
                select: {
                  externalKey: true,
                  name: true,
                  domain: true,
                  sourceType: true,
                  officialStatus: true,
                },
              },
              observations: {
                where: { reliability: "valid" },
                orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
                take: 1,
              },
            },
          },
        },
      }),
    ]);

    const items = products.map((product) => {
      const offers = product.offers.map((offer) => ({
        offerId: offer.id,
        url: offer.competitorUrl,
        seller: offer.seller.displayName,
        source: offer.source,
        isOwn: offer.source.domain === "centr-to.ru" || offer.competitorUrl === product.ownUrl,
        price: offer.observations[0] ? priceDto(offer.observations[0]) : null,
      }));
      const own = offers.find((offer) => offer.isOwn) ?? null;
      const ownValue = own?.price?.normalizedPrice ?? null;
      const competitors = offers
        .filter((offer) => !offer.isOwn)
        .map((offer) => ({
          ...offer,
          difference: comparisonDelta(ownValue, offer.price?.normalizedPrice ?? null),
        }));
      return {
        product: {
          id: product.id,
          externalKey: product.externalKey,
          name: product.name,
          article: product.article,
          ownUrl: product.ownUrl,
          catalogScope: product.catalogScope,
        },
        own,
        competitors,
      };
    });
    return { total, items, limit: query.limit, offset: query.offset };
  }

  async history(productId: string, query: HistoryQuery) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, name: true },
    });
    if (!product) throw new NotFoundException("Product not found");

    const where = { offer: { productId } };
    const [total, observations] = await Promise.all([
      this.prisma.priceObservation.count({ where }),
      this.prisma.priceObservation.findMany({
        where,
        orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
        skip: query.offset,
        take: query.limit,
        include: {
          offer: {
            select: {
              competitorUrl: true,
              seller: { select: { displayName: true } },
              source: { select: { externalKey: true, name: true, domain: true } },
            },
          },
          job: { select: { id: true, triggerType: true, status: true } },
        },
      }),
    ]);
    return {
      product,
      total,
      items: observations.map((observation) => ({
        ...priceDto(observation),
        offer: observation.offer,
        job: observation.job,
      })),
      limit: query.limit,
      offset: query.offset,
    };
  }

  async addManualObservation(input: ManualObservationInput) {
    return this.prisma.$transaction(async (transaction) => {
      const offer = await transaction.offer.findUnique({
        where: { id: input.offerId },
        include: {
          product: { select: { id: true, name: true } },
          source: { select: { id: true, isActive: true, name: true } },
        },
      });
      if (!offer || !offer.isActive || !offer.source.isActive) {
        throw new NotFoundException("Active offer not found");
      }

      const evaluation = evaluateManualPrice(offer.matchStatus, input);
      const now = new Date();
      const observedAt = input.observedAt ? new Date(input.observedAt) : now;
      const job = await transaction.collectionJob.create({
        data: {
          triggerType: "manual",
          status: "success",
          scheduledFor: now,
          startedAt: now,
          finishedAt: now,
          summary: {
            status: "success",
            total: 1,
            succeeded: 1,
            failed: 0,
            skipped: 0,
            manual: true,
          },
        },
      });
      const attempt = await transaction.collectionAttempt.create({
        data: {
          jobId: job.id,
          sourceId: offer.sourceId,
          offerId: offer.id,
          attemptNumber: 1,
          method: "manual",
          status: "success",
          startedAt: now,
          finishedAt: now,
        },
      });
      const observation = await transaction.priceObservation.create({
        data: {
          jobId: job.id,
          attemptId: attempt.id,
          offerId: offer.id,
          rawPrice: input.rawPrice,
          normalizedPrice: evaluation.normalizedPrice,
          currency: input.currency,
          sourceQuantity: input.quantity,
          normalizedQuantity: evaluation.normalizedPrice ? "1" : null,
          unit: input.unit,
          priceType: input.priceType,
          vatIncluded: input.vatIncluded,
          stockStatus: input.stockStatus,
          region: input.region,
          deliveryIncluded: input.deliveryIncluded,
          installationIncluded: input.installationIncluded,
          observedAt,
          method: "manual",
          reliability: evaluation.reliability,
          exclusionReason: evaluation.exclusionReason,
          evidenceText: input.evidenceText,
          evidenceJson: {
            submittedThrough: "api",
            ...(input.comment ? { comment: input.comment } : {}),
          },
          collectorVersion: "api-manual/0.1.0",
        },
      });
      return {
        jobId: job.id,
        product: offer.product,
        offerId: offer.id,
        source: offer.source.name,
        observation: priceDto(observation),
      };
    });
  }
}
