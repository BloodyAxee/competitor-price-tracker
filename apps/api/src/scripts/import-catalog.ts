import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  assertUniqueExternalKeys,
  catalogExternalKey,
  parseAdditionalCatalog,
  parseRequiredCatalog,
} from "../import/catalog-files.ts";
import { createPrismaClient } from "../database/client.ts";

interface ResearchModel {
  model: string;
  own_url: string | null;
  primary_url: string | null;
  reserve_url: string | null;
  verified_exact_urls?: string[];
  match_status: string;
  review_scope: string;
  note: string;
}

interface ResearchRegistry {
  models: ResearchModel[];
  bundle_offers: Array<{
    bundle_model: string;
    seller_domain: string;
    seller_name: string;
    verified_on: string;
    components: Array<{ article: string; url: string; match_reason: string }>;
  }>;
}

interface SourceProfile {
  displayName: string;
  sourceType: "manufacturer" | "official_dealer" | "retailer" | "marketplace" | "manual";
  officialStatus: "unknown" | "self_claimed" | "verified_dealer" | "manufacturer";
  requestTimeoutSeconds?: number;
  maxRetries?: number;
  rateLimitPerHost?: number;
}

const sourceProfiles: Record<string, SourceProfile> = {
  "centr-to.ru": {
    displayName: "ЦТО",
    sourceType: "retailer",
    officialStatus: "self_claimed",
    requestTimeoutSeconds: 45,
    maxRetries: 2,
    rateLimitPerHost: 0.5,
  },
  "nordberg.ru": {
    displayName: "NORDBERG",
    sourceType: "manufacturer",
    officialStatus: "manufacturer",
  },
  "eqfs.ru": {
    displayName: "EQFS",
    sourceType: "manufacturer",
    officialStatus: "manufacturer",
  },
  "si-tools.ru": {
    displayName: "Станкоимпорт",
    sourceType: "manufacturer",
    officialStatus: "manufacturer",
  },
  "technovector.ru": {
    displayName: "ТехноВектор",
    sourceType: "manufacturer",
    officialStatus: "manufacturer",
  },
  "nordberg-shop.ru": {
    displayName: "Автодело",
    sourceType: "official_dealer",
    officialStatus: "verified_dealer",
  },
  "master-instrument.ru": {
    displayName: "Мастер-Инструмент",
    sourceType: "official_dealer",
    officialStatus: "verified_dealer",
  },
  "avto-master.ru": {
    displayName: "Автомастер",
    sourceType: "official_dealer",
    officialStatus: "verified_dealer",
  },
  "topmaster-shop.ru": {
    displayName: "Топ Мастер",
    sourceType: "retailer",
    officialStatus: "unknown",
  },
};

const DEFAULT_REQUEST_TIMEOUT_SECONDS = 12;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RATE_LIMIT_PER_HOST = 0.5;

function baseDomain(rawUrl: string): string {
  const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
  const labels = hostname.split(".");
  return labels.slice(-2).join(".");
}

function sourceProfile(domain: string): SourceProfile {
  return (
    sourceProfiles[domain] ?? {
      displayName: domain,
      sourceType: "retailer",
      officialStatus: "unknown",
    }
  );
}

const dataRoot = process.env.CATALOG_DATA_DIR
  ? path.resolve(process.env.CATALOG_DATA_DIR)
  : path.resolve(process.cwd(), "../../data");

const [requiredText, additionalText, registryText] = await Promise.all([
  readFile(path.join(dataRoot, "input/modeli.csv"), "utf8"),
  readFile(path.join(dataRoot, "input/modeli-dop.csv"), "utf8"),
  readFile(path.join(dataRoot, "research/model-registry.json"), "utf8"),
]);

const required = parseRequiredCatalog(requiredText);
const additional = parseAdditionalCatalog(additionalText);
const registry = JSON.parse(registryText) as ResearchRegistry;

if (required.length !== 29 || additional.length !== 238 || registry.models.length !== 29) {
  throw new Error("Catalog or research registry row count does not match the agreed input");
}

assertUniqueExternalKeys(
  required.map((row) => ({ model: row.model, discriminator: row.ownUrl })),
  "required",
);
assertUniqueExternalKeys(
  additional.map((row) => ({ model: row.model, discriminator: row.article })),
  "additional",
);

const prisma = createPrismaClient();

try {
  await prisma.$transaction(async (tx) => {
    const productByName = new Map<string, { id: string; article: string | null }>();
    const additionalByArticle = new Map<string, { id: string; name: string }>();

    for (const row of required) {
      const product = await tx.product.upsert({
        where: {
          externalKey: catalogExternalKey("required", row.model, row.ownUrl),
        },
        create: {
          externalKey: catalogExternalKey("required", row.model, row.ownUrl),
          name: row.model,
          ownUrl: row.ownUrl,
          catalogScope: "required",
          priority: 10,
        },
        update: {
          name: row.model,
          ownUrl: row.ownUrl,
          catalogScope: "required",
          priority: 10,
          isActive: true,
          updatedAt: new Date(),
        },
        select: { id: true, article: true },
      });
      productByName.set(row.model, product);
    }

    for (const row of additional) {
      const product = await tx.product.upsert({
        where: {
          externalKey: catalogExternalKey("additional", row.model, row.article),
        },
        create: {
          externalKey: catalogExternalKey("additional", row.model, row.article),
          name: row.model,
          article: row.article,
          catalogScope: "additional",
          priority: 100,
        },
        update: {
          name: row.model,
          article: row.article,
          catalogScope: "additional",
          priority: 100,
          isActive: true,
          updatedAt: new Date(),
        },
        select: { id: true, name: true },
      });
      if (row.article) additionalByArticle.set(row.article, product);
    }

    const bundle = productByName.get("Шиномонтажный комплект NORDBERG 4641N + VT-64");
    const components = [
      { article: "4641N", product: additionalByArticle.get("4641N") },
      { article: "VT-64.5005", product: additionalByArticle.get("VT-64.5005") },
    ];
    if (!bundle || components.some((component) => !component.product)) {
      throw new Error("Bundle or one of its agreed components is missing");
    }
    for (const component of components) {
      await tx.product.update({
        where: { id: component.product!.id },
        data: { catalogScope: "component", priority: 20, updatedAt: new Date() },
      });
      await tx.productComponent.upsert({
        where: {
          bundleProductId_componentProductId: {
            bundleProductId: bundle.id,
            componentProductId: component.product!.id,
          },
        },
        create: {
          bundleProductId: bundle.id,
          componentProductId: component.product!.id,
          quantity: 1,
        },
        update: { quantity: 1 },
      });
    }

    const legacyManualSource = await tx.source.findUnique({
      where: { externalKey: "source:manual-bundle" },
      select: { id: true },
    });
    if (legacyManualSource) {
      await tx.offer.updateMany({
        where: { sourceId: legacyManualSource.id },
        data: { isActive: false, updatedAt: new Date() },
      });
      await tx.source.update({
        where: { id: legacyManualSource.id },
        data: { isActive: false, updatedAt: new Date() },
      });
    }

    for (const bundleOffer of registry.bundle_offers) {
      if (bundleOffer.bundle_model !== "Шиномонтажный комплект NORDBERG 4641N + VT-64") {
        throw new Error(`Unsupported researched bundle: ${bundleOffer.bundle_model}`);
      }
      if (bundleOffer.components.length !== components.length) {
        throw new Error("A researched bundle offer must contain every agreed component");
      }
      const profile = sourceProfile(bundleOffer.seller_domain);
      const seller = await tx.seller.upsert({
        where: { externalKey: `seller:${bundleOffer.seller_domain}` },
        create: {
          externalKey: `seller:${bundleOffer.seller_domain}`,
          displayName: bundleOffer.seller_name,
          websiteUrl: `https://${bundleOffer.seller_domain}`,
          officialStatus: profile.officialStatus,
        },
        update: {
          displayName: bundleOffer.seller_name,
          websiteUrl: `https://${bundleOffer.seller_domain}`,
          officialStatus: profile.officialStatus,
          updatedAt: new Date(),
        },
      });
      const source = await tx.source.upsert({
        where: { externalKey: `source:${bundleOffer.seller_domain}` },
        create: {
          externalKey: `source:${bundleOffer.seller_domain}`,
          sellerId: seller.id,
          name: bundleOffer.seller_name,
          baseUrl: `https://${bundleOffer.seller_domain}`,
          domain: bundleOffer.seller_domain,
          sourceType: profile.sourceType,
          officialStatus: profile.officialStatus,
          requestTimeoutSeconds: DEFAULT_REQUEST_TIMEOUT_SECONDS,
          maxRetries: DEFAULT_MAX_RETRIES,
          rateLimitPerHost: DEFAULT_RATE_LIMIT_PER_HOST,
        },
        update: {
          sellerId: seller.id,
          name: bundleOffer.seller_name,
          isActive: true,
          updatedAt: new Date(),
        },
      });
      for (const researchedComponent of bundleOffer.components) {
        const component = components.find((candidate) => candidate.article === researchedComponent.article);
        if (!component?.product || baseDomain(researchedComponent.url) !== bundleOffer.seller_domain) {
          throw new Error(`Invalid researched bundle component: ${researchedComponent.article}`);
        }
        await tx.offer.upsert({
          where: {
            productId_sourceId_competitorUrl: {
              productId: component.product.id,
              sourceId: source.id,
              competitorUrl: researchedComponent.url,
            },
          },
          create: {
            productId: component.product.id,
            sellerId: seller.id,
            sourceId: source.id,
            competitorUrl: researchedComponent.url,
            sellerArticle: researchedComponent.article,
            matchStatus: "exact",
            matchReason: `${researchedComponent.match_reason}. Проверено ${bundleOffer.verified_on}.`,
          },
          update: {
            sellerId: seller.id,
            sellerArticle: researchedComponent.article,
            matchStatus: "exact",
            matchReason: `${researchedComponent.match_reason}. Проверено ${bundleOffer.verified_on}.`,
            isActive: true,
            updatedAt: new Date(),
          },
        });
      }
    }

    for (const research of registry.models) {
      const product = productByName.get(research.model);
      if (!product) throw new Error(`Research product not found in catalog: ${research.model}`);

      const candidates: Array<{ kind: "own" | "primary" | "reserve"; url: string }> = [];
      if (research.own_url) {
        candidates.push({ kind: "own", url: research.own_url });
      }
      if (research.primary_url) {
        candidates.push({ kind: "primary", url: research.primary_url });
      }
      if (research.reserve_url) {
        candidates.push({ kind: "reserve", url: research.reserve_url });
      }

      for (const candidate of candidates) {
        const domain = baseDomain(candidate.url);
        const profile = sourceProfile(domain);
        const seller = await tx.seller.upsert({
          where: { externalKey: `seller:${domain}` },
          create: {
            externalKey: `seller:${domain}`,
            displayName: profile.displayName,
            websiteUrl: `https://${domain}`,
            officialStatus: profile.officialStatus,
          },
          update: {
            displayName: profile.displayName,
            websiteUrl: `https://${domain}`,
            officialStatus: profile.officialStatus,
            updatedAt: new Date(),
          },
        });
        const source = await tx.source.upsert({
          where: { externalKey: `source:${domain}` },
          create: {
            externalKey: `source:${domain}`,
            sellerId: seller.id,
            name: profile.displayName,
            baseUrl: `https://${domain}`,
            domain,
            sourceType: profile.sourceType,
            officialStatus: profile.officialStatus,
            requestTimeoutSeconds:
              profile.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS,
            maxRetries: profile.maxRetries ?? DEFAULT_MAX_RETRIES,
            rateLimitPerHost: profile.rateLimitPerHost ?? DEFAULT_RATE_LIMIT_PER_HOST,
          },
          update: {
            sellerId: seller.id,
            name: profile.displayName,
            sourceType: profile.sourceType,
            officialStatus: profile.officialStatus,
            requestTimeoutSeconds:
              profile.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS,
            maxRetries: profile.maxRetries ?? DEFAULT_MAX_RETRIES,
            rateLimitPerHost: profile.rateLimitPerHost ?? DEFAULT_RATE_LIMIT_PER_HOST,
            isActive: true,
            updatedAt: new Date(),
          },
        });
        const isExactOffer =
          candidate.kind === "own" ||
          (research.match_status === "точное совпадение" &&
            (candidate.kind === "primary" ||
              research.verified_exact_urls?.includes(candidate.url) === true));
        const sourceLabel =
          candidate.kind === "own"
            ? "Собственная карточка"
            : candidate.kind === "primary"
              ? "Основной источник"
              : "Резервный источник";
        const matchReason = `${sourceLabel}. ${research.review_scope}. ${research.note}`;
        const sellerArticle =
          candidate.kind === "own" ? candidate.url.match(/\/good-(\d+)-/)?.[1] : undefined;
        await tx.offer.upsert({
          where: {
            productId_sourceId_competitorUrl: {
              productId: product.id,
              sourceId: source.id,
              competitorUrl: candidate.url,
            },
          },
          create: {
            productId: product.id,
            sellerId: seller.id,
            sourceId: source.id,
            competitorUrl: candidate.url,
            sellerArticle,
            matchStatus: isExactOffer ? "exact" : "review",
            matchReason,
          },
          update: {
            sellerId: seller.id,
            sellerArticle,
            matchStatus: isExactOffer ? "exact" : "review",
            matchReason,
            isActive: true,
            updatedAt: new Date(),
          },
        });
      }
    }
  });

  const [
    requiredCount,
    additionalCount,
    componentProductCount,
    ownUrlCount,
    componentLinkCount,
    offerCount,
  ] =
    await Promise.all([
      prisma.product.count({ where: { catalogScope: "required", isActive: true } }),
      prisma.product.count({ where: { catalogScope: "additional", isActive: true } }),
      prisma.product.count({ where: { catalogScope: "component", isActive: true } }),
      prisma.product.count({
        where: { catalogScope: "required", isActive: true, ownUrl: { not: null } },
      }),
      prisma.productComponent.count(),
      prisma.offer.count({ where: { isActive: true } }),
    ]);

  if (
    requiredCount !== 29 ||
    additionalCount !== 236 ||
    componentProductCount !== 2 ||
    ownUrlCount !== 28 ||
    componentLinkCount < 2
  ) {
    throw new Error("Imported catalog failed the acceptance counts");
  }

  console.log(
    `Catalog import complete: ${requiredCount} required, ${additionalCount} additional, ${componentProductCount} components, ${ownUrlCount} own URLs, ${componentLinkCount} bundle links, ${offerCount} research offers.`,
  );
} finally {
  await prisma.$disconnect();
}
