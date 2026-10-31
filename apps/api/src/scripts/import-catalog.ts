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
  primary_url: string | null;
  reserve_url: string | null;
  match_status: string;
  review_scope: string;
  note: string;
}

interface ResearchRegistry {
  models: ResearchModel[];
}

interface SourceProfile {
  displayName: string;
  sourceType: "manufacturer" | "official_dealer" | "retailer" | "marketplace" | "manual";
  officialStatus: "unknown" | "self_claimed" | "verified_dealer" | "manufacturer";
}

const sourceProfiles: Record<string, SourceProfile> = {
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
};

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
      additionalByArticle.get("4641N"),
      additionalByArticle.get("VT-64.5005"),
    ];
    if (!bundle || components.some((component) => !component)) {
      throw new Error("Bundle or one of its agreed components is missing");
    }
    for (const component of components) {
      await tx.productComponent.upsert({
        where: {
          bundleProductId_componentProductId: {
            bundleProductId: bundle.id,
            componentProductId: component!.id,
          },
        },
        create: {
          bundleProductId: bundle.id,
          componentProductId: component!.id,
          quantity: 1,
        },
        update: { quantity: 1 },
      });
    }

    for (const research of registry.models) {
      const product = productByName.get(research.model);
      if (!product) throw new Error(`Research product not found in catalog: ${research.model}`);

      const candidates = [
        { kind: "primary", url: research.primary_url },
        { kind: "reserve", url: research.reserve_url },
      ].filter((candidate): candidate is { kind: string; url: string } => Boolean(candidate.url));

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
          },
          update: {
            sellerId: seller.id,
            name: profile.displayName,
            sourceType: profile.sourceType,
            officialStatus: profile.officialStatus,
            isActive: true,
            updatedAt: new Date(),
          },
        });
        const isExactPrimary =
          candidate.kind === "primary" && research.match_status === "точное совпадение";
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
            matchStatus: isExactPrimary ? "exact" : "review",
            matchReason: `${candidate.kind === "primary" ? "Основной" : "Резервный"} источник. ${research.review_scope}. ${research.note}`,
          },
          update: {
            sellerId: seller.id,
            matchStatus: isExactPrimary ? "exact" : "review",
            matchReason: `${candidate.kind === "primary" ? "Основной" : "Резервный"} источник. ${research.review_scope}. ${research.note}`,
            isActive: true,
            updatedAt: new Date(),
          },
        });
      }
    }
  });

  const [requiredCount, additionalCount, ownUrlCount, componentCount, offerCount] =
    await Promise.all([
      prisma.product.count({ where: { catalogScope: "required", isActive: true } }),
      prisma.product.count({ where: { catalogScope: "additional", isActive: true } }),
      prisma.product.count({
        where: { catalogScope: "required", isActive: true, ownUrl: { not: null } },
      }),
      prisma.productComponent.count(),
      prisma.offer.count({ where: { isActive: true } }),
    ]);

  if (
    requiredCount !== 29 ||
    additionalCount !== 238 ||
    ownUrlCount !== 28 ||
    componentCount < 2
  ) {
    throw new Error("Imported catalog failed the acceptance counts");
  }

  console.log(
    `Catalog import complete: ${requiredCount} required, ${additionalCount} additional, ${ownUrlCount} own URLs, ${componentCount} bundle components, ${offerCount} research offers.`,
  );
} finally {
  await prisma.$disconnect();
}
