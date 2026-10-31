export type ManualPriceType = "rrp" | "retail" | "sale" | "quote" | "unknown";
export type PriceReliability = "valid" | "review" | "unreliable";

export interface ManualPriceCandidate {
  rawPrice: string;
  quantity: string;
  priceType: ManualPriceType;
  isFromPrice: boolean;
  isStale: boolean;
  packageHomogeneous: boolean;
}

export interface ManualPriceEvaluation {
  normalizedPrice: string | null;
  reliability: PriceReliability;
  exclusionReason: string | null;
}

function decision(
  reliability: PriceReliability,
  exclusionReason: string | null,
  normalizedPrice: string | null = null,
): ManualPriceEvaluation {
  return { normalizedPrice, reliability, exclusionReason };
}

export function evaluateManualPrice(
  matchStatus: string,
  candidate: ManualPriceCandidate,
): ManualPriceEvaluation {
  if (candidate.priceType === "quote") {
    return decision("unreliable", "quote_only");
  }
  if (matchStatus !== "exact") {
    return decision("unreliable", "non_exact_product");
  }
  if (candidate.isFromPrice) {
    return decision("unreliable", "price_from");
  }
  if (candidate.isStale) {
    return decision("unreliable", "stale_page");
  }
  if (candidate.priceType === "unknown") {
    return decision("review", "unknown_price_type");
  }

  const quantity = Number(candidate.quantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    return decision("unreliable", "invalid_package_quantity");
  }
  if (!candidate.packageHomogeneous && quantity !== 1) {
    return decision("unreliable", "heterogeneous_package");
  }

  const normalizedPrice = (Number(candidate.rawPrice) / quantity).toFixed(2);
  return decision("valid", null, normalizedPrice);
}
