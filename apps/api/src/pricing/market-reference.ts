export interface ReferencePriceInput {
  rawPrice: { toString(): string } | null;
  normalizedPrice: { toString(): string } | null;
  priceType: string;
  unit: string | null;
}

export interface ReferenceDifference {
  amount: string;
  percent: string;
}

function priceValue(price: ReferencePriceInput) {
  const value = Number((price.normalizedPrice ?? price.rawPrice)?.toString());
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function calculateMarketReferenceDifference(
  ownPrice: ReferencePriceInput | null | undefined,
  candidatePrice: ReferencePriceInput | null | undefined,
): ReferenceDifference | null {
  if (!ownPrice || !candidatePrice) return null;
  if (ownPrice.priceType === "unknown" || ownPrice.priceType !== candidatePrice.priceType) {
    return null;
  }
  if (ownPrice.unit && candidatePrice.unit && ownPrice.unit !== candidatePrice.unit) return null;

  const own = priceValue(ownPrice);
  const candidate = priceValue(candidatePrice);
  if (own == null || candidate == null) return null;
  return {
    amount: (candidate - own).toFixed(2),
    percent: (((candidate - own) / own) * 100).toFixed(2),
  };
}
