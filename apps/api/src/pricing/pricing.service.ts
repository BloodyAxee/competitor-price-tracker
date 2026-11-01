import { Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "../generated/prisma/client.ts";
import { PrismaService } from "../database/prisma.service.ts";
import {
  createPriceCsv,
  exportMethod,
  exportReliability,
  type PriceExportRow,
} from "./csv-export.ts";
import { evaluateBundle } from "./bundle-price.ts";
import { evaluateManualPrice, type ManualPriceType } from "./manual-price.ts";
import { calculatePriceMovement } from "./price-movement.ts";

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

function evidenceComment(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const comment = (value as Record<string, unknown>).comment;
  return typeof comment === "string" && comment.trim() ? comment.trim() : null;
}

function exportPriceUnit(quantity: { toString(): string } | null, unit: string | null) {
  const normalizedUnit = unit === "piece" ? "шт." : (unit ?? "не указано");
  return `${quantity?.toString() ?? "1"} ${normalizedUnit}`;
}

function exportComment(parts: Array<string | null | undefined>) {
  return [...new Set(parts.map((part) => part?.trim()).filter((part): part is string => Boolean(part)))].join(
    "\n",
  );
}

@Injectable()
export class PricingService {
  constructor(private readonly prisma: PrismaService) {}

  async exportCsv() {
    const products = await this.prisma.product.findMany({
      where: { isActive: true },
      orderBy: [{ priority: "asc" }, { name: "asc" }],
      select: {
        name: true,
        ownUrl: true,
        offers: {
          where: { isActive: true, source: { isActive: true } },
          orderBy: [{ createdAt: "asc" }],
          select: {
            competitorUrl: true,
            seller: { select: { displayName: true } },
            source: { select: { domain: true } },
            observations: {
              orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
              select: {
                rawPrice: true,
                normalizedPrice: true,
                sourceQuantity: true,
                normalizedQuantity: true,
                unit: true,
                observedAt: true,
                receivedAt: true,
                method: true,
                reliability: true,
                exclusionReason: true,
                evidenceText: true,
                evidenceJson: true,
              },
            },
          },
        },
        bundleParts: {
          orderBy: { componentProduct: { name: "asc" } },
          select: {
            quantity: true,
            componentProduct: {
              select: {
                id: true,
                offers: {
                  where: {
                    isActive: true,
                    matchStatus: "exact",
                    source: { isActive: true },
                  },
                  select: {
                    id: true,
                    competitorUrl: true,
                    sellerId: true,
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
                      select: {
                        normalizedPrice: true,
                        currency: true,
                        priceType: true,
                        method: true,
                        receivedAt: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    const rows: PriceExportRow[] = [];
    for (const product of products) {
      for (const offer of product.offers) {
        const isOwn = offer.source.domain === "centr-to.ru" || offer.competitorUrl === product.ownUrl;
        if (isOwn) continue;
        for (const observation of offer.observations) {
          const normalized = observation.normalizedPrice != null;
          rows.push({
            model: product.name,
            nash_url: product.ownUrl ?? "",
            konkurent: offer.seller.displayName,
            konkurent_url: offer.competitorUrl,
            cena: (observation.normalizedPrice ?? observation.rawPrice)?.toString() ?? "",
            cena_za: exportPriceUnit(
              normalized ? observation.normalizedQuantity : observation.sourceQuantity,
              observation.unit,
            ),
            data_sbora: (observation.observedAt ?? observation.receivedAt).toISOString(),
            sposob: exportMethod(observation.method),
            nadezhnost: exportReliability(observation.reliability),
            kommentariy: exportComment([
              observation.exclusionReason,
              observation.evidenceText,
              evidenceComment(observation.evidenceJson),
            ]),
          });
        }
      }
      const bundle = evaluateBundle(
        product.bundleParts.map((part) => ({
          componentId: part.componentProduct.id,
          quantity: part.quantity.toString(),
          offers: part.componentProduct.offers.map((offer) => ({
            offerId: offer.id,
            sellerId: offer.sellerId,
            sellerName: offer.seller.displayName,
            url: offer.competitorUrl,
            source: offer.source,
            observation: offer.observations[0]
              ? {
                  normalizedPrice: offer.observations[0].normalizedPrice!.toString(),
                  currency: offer.observations[0].currency.trim(),
                  priceType: offer.observations[0].priceType,
                  method: offer.observations[0].method,
                  receivedAt: offer.observations[0].receivedAt,
                }
              : null,
          })),
        })),
      );
      for (const candidate of bundle.candidates) {
        rows.push({
          model: product.name,
          nash_url: product.ownUrl ?? "",
          konkurent: candidate.sellerName,
          konkurent_url: candidate.url,
          cena: candidate.totalPrice,
          cena_za: "1 комплект",
          data_sbora: candidate.receivedAt.toISOString(),
          sposob: exportMethod(candidate.method),
          nadezhnost: exportReliability("valid"),
          kommentariy: "Сумма 4641N и VT-64 у одного продавца",
        });
      }
    }
    return createPriceCsv(rows);
  }

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
            where: {
              isActive: true,
              matchStatus: { in: ["exact", "review"] },
              source: { isActive: true },
            },
            orderBy: [{ matchStatus: "asc" }, { createdAt: "asc" }],
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
            },
          },
          bundleParts: {
            orderBy: { componentProduct: { name: "asc" } },
            select: {
              quantity: true,
              componentProduct: {
                select: {
                  id: true,
                  offers: {
                    where: {
                      isActive: true,
                      matchStatus: "exact",
                      source: { isActive: true },
                    },
                    orderBy: [{ createdAt: "asc" }],
                    select: {
                      id: true,
                      competitorUrl: true,
                      sellerId: true,
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
                        select: {
                          normalizedPrice: true,
                          currency: true,
                          priceType: true,
                          method: true,
                          receivedAt: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    const directOfferIds = products.flatMap((product) => product.offers.map((offer) => offer.id));
    const [recentObservations, latestValidObservations] = directOfferIds.length
      ? await Promise.all([
          this.prisma.priceObservation.findMany({
            where: { offerId: { in: directOfferIds } },
            orderBy: [{ offerId: "asc" }, { receivedAt: "desc" }, { id: "desc" }],
          }),
          this.prisma.priceObservation.findMany({
            where: { offerId: { in: directOfferIds }, reliability: "valid" },
            orderBy: [{ offerId: "asc" }, { receivedAt: "desc" }, { id: "desc" }],
            distinct: ["offerId"],
          }),
        ])
      : [[], []];
    const recentObservationsByOffer = new Map<string, typeof recentObservations>();
    for (const observation of recentObservations) {
      const offerObservations = recentObservationsByOffer.get(observation.offerId) ?? [];
      if (offerObservations.length < 2) {
        offerObservations.push(observation);
        recentObservationsByOffer.set(observation.offerId, offerObservations);
      }
    }
    const latestObservationByOffer = new Map(
      [...recentObservationsByOffer].flatMap(([offerId, observations]) =>
        observations[0] ? [[offerId, observations[0]] as const] : [],
      ),
    );
    const previousObservationByOffer = new Map(
      [...recentObservationsByOffer].flatMap(([offerId, observations]) =>
        observations[1] ? [[offerId, observations[1]] as const] : [],
      ),
    );
    const latestValidObservationByOffer = new Map(
      latestValidObservations.map((observation) => [observation.offerId, observation]),
    );

    const items = products.map((product) => {
      const offers = product.offers.map((offer) => {
        const latestObservation = latestObservationByOffer.get(offer.id);
        const previousObservation = previousObservationByOffer.get(offer.id);
        const latestValidObservation = latestValidObservationByOffer.get(offer.id);
        return {
          offerId: offer.id,
          url: offer.competitorUrl,
          seller: offer.seller.displayName,
          source: offer.source,
          matchStatus: offer.matchStatus,
          matchReason: offer.matchReason,
          isOwn: offer.source.domain === "centr-to.ru" || offer.competitorUrl === product.ownUrl,
          price: latestObservation ? priceDto(latestObservation) : null,
          priceChange: calculatePriceMovement(
            latestObservation?.normalizedPrice?.toString() ?? null,
            previousObservation?.normalizedPrice?.toString() ?? null,
          ),
          comparisonPrice:
            offer.matchStatus === "exact" && latestValidObservation
              ? priceDto(latestValidObservation)
              : null,
        };
      });
      const own = offers.find((offer) => offer.isOwn) ?? null;
      const ownValue = own?.comparisonPrice?.normalizedPrice ?? null;
      const directCompetitors = offers
        .filter((offer) => !offer.isOwn)
        .map((offer) => ({
          ...offer,
          difference: comparisonDelta(ownValue, offer.comparisonPrice?.normalizedPrice ?? null),
        }));
      const bundle = evaluateBundle(
        product.bundleParts.map((part) => ({
          componentId: part.componentProduct.id,
          quantity: part.quantity.toString(),
          offers: part.componentProduct.offers.map((offer) => ({
            offerId: offer.id,
            sellerId: offer.sellerId,
            sellerName: offer.seller.displayName,
            url: offer.competitorUrl,
            source: offer.source,
            observation: offer.observations[0]
              ? {
                  normalizedPrice: offer.observations[0].normalizedPrice!.toString(),
                  currency: offer.observations[0].currency.trim(),
                  priceType: offer.observations[0].priceType,
                  method: offer.observations[0].method,
                  receivedAt: offer.observations[0].receivedAt,
                }
              : null,
          })),
        })),
      );
      const bundleCompetitors = bundle.candidates.map((candidate) => ({
        offerId: `bundle:${product.id}:${candidate.sellerId}`,
        url: candidate.url,
        seller: candidate.sellerName,
        source: candidate.source,
        matchStatus: "exact",
        matchReason: "Цена комплекта рассчитана по двум компонентам одного продавца",
        isOwn: false,
        price: {
          id: `bundle:${product.id}:${candidate.sellerId}`,
          rawPrice: candidate.totalPrice,
          normalizedPrice: candidate.totalPrice,
          currency: candidate.currency,
          unit: "set",
          priceType: candidate.priceType,
          vatIncluded: null,
          stockStatus: null,
          region: null,
          deliveryIncluded: null,
          installationIncluded: null,
          observedAt: candidate.receivedAt,
          receivedAt: candidate.receivedAt,
          method: candidate.method,
          reliability: "valid",
          exclusionReason: null,
          evidenceText: "Сумма цен 4641N и VT-64 у одного продавца",
        },
        comparisonPrice: {
          id: `bundle:${product.id}:${candidate.sellerId}`,
          rawPrice: candidate.totalPrice,
          normalizedPrice: candidate.totalPrice,
          currency: candidate.currency,
          unit: "set",
          priceType: candidate.priceType,
          vatIncluded: null,
          stockStatus: null,
          region: null,
          deliveryIncluded: null,
          installationIncluded: null,
          observedAt: candidate.receivedAt,
          receivedAt: candidate.receivedAt,
          method: candidate.method,
          reliability: "valid",
          exclusionReason: null,
          evidenceText: "Сумма цен 4641N и VT-64 у одного продавца",
        },
        priceChange: null,
        difference: comparisonDelta(ownValue, candidate.totalPrice),
      }));
      const competitors = [...directCompetitors, ...bundleCompetitors];
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
        bundleStatus:
          product.bundleParts.length > 0
            ? {
                ready: bundle.candidates.length > 0,
                exclusionReason: bundle.exclusionReason,
              }
            : null,
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
