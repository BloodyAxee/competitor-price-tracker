export interface BundleObservation {
  normalizedPrice: string;
  currency: string;
  priceType: string;
  method: string;
  receivedAt: Date;
}

export interface BundleOffer {
  offerId: string;
  sellerId: string;
  sellerName: string;
  url: string;
  source: {
    externalKey: string;
    name: string;
    domain: string | null;
    sourceType: string;
    officialStatus: string;
  };
  observation: BundleObservation | null;
}

export interface BundlePart {
  componentId: string;
  quantity: string;
  offers: BundleOffer[];
}

export interface BundleCandidate {
  sellerId: string;
  sellerName: string;
  totalPrice: string;
  currency: string;
  priceType: string;
  method: string;
  receivedAt: Date;
  url: string;
  source: BundleOffer["source"];
}

export interface BundleEvaluation {
  candidates: BundleCandidate[];
  exclusionReason: "incomplete_bundle" | "mixed_sellers" | "mixed_price_types" | null;
}

function latestOffer(offers: BundleOffer[]) {
  return [...offers]
    .filter((offer) => offer.observation)
    .sort(
      (left, right) =>
        right.observation!.receivedAt.getTime() - left.observation!.receivedAt.getTime(),
    )[0];
}

export function evaluateBundle(parts: BundlePart[]): BundleEvaluation {
  if (parts.length === 0) return { candidates: [], exclusionReason: "incomplete_bundle" };

  const sellerIds = new Set(
    parts.flatMap((part) =>
      part.offers.filter((offer) => offer.observation).map((offer) => offer.sellerId),
    ),
  );
  const candidates: BundleCandidate[] = [];
  let foundMixedPriceTypes = false;

  for (const sellerId of sellerIds) {
    const selected = parts.map((part) =>
      latestOffer(part.offers.filter((offer) => offer.sellerId === sellerId)),
    );
    if (selected.some((offer) => !offer)) continue;

    const complete = selected as BundleOffer[];
    const observations = complete.map((offer) => offer.observation!);
    if (
      new Set(observations.map((observation) => observation.currency)).size !== 1 ||
      new Set(observations.map((observation) => observation.priceType)).size !== 1
    ) {
      foundMixedPriceTypes = true;
      continue;
    }
    const total = observations.reduce(
      (sum, observation, index) =>
        sum + Number(observation.normalizedPrice) * Number(parts[index]!.quantity),
      0,
    );
    if (!Number.isFinite(total) || total <= 0) continue;

    const newest = observations.reduce((left, right) =>
      right.receivedAt > left.receivedAt ? right : left,
    );
    candidates.push({
      sellerId,
      sellerName: complete[0]!.sellerName,
      totalPrice: total.toFixed(2),
      currency: observations[0]!.currency,
      priceType: observations[0]!.priceType,
      method: observations.some((observation) => observation.method === "manual")
        ? "manual"
        : "automatic",
      receivedAt: newest.receivedAt,
      url: complete[0]!.url,
      source: complete[0]!.source,
    });
  }

  if (candidates.length > 0) return { candidates, exclusionReason: null };
  if (foundMixedPriceTypes) return { candidates: [], exclusionReason: "mixed_price_types" };
  const everyPartHasPrice = parts.every((part) =>
    part.offers.some((offer) => offer.observation),
  );
  return {
    candidates: [],
    exclusionReason: everyPartHasPrice ? "mixed_sellers" : "incomplete_bundle",
  };
}
