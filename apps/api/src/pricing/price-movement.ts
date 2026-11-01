export interface PriceMovement {
  previousPrice: string;
  amount: string;
  percent: string;
  direction: "up" | "down";
}

export function calculatePriceMovement(
  currentPrice: string | null,
  previousPrice: string | null,
): PriceMovement | null {
  if (!currentPrice || !previousPrice) return null;
  const current = Number(currentPrice);
  const previous = Number(previousPrice);
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  const amount = current - previous;
  if (amount === 0) return null;
  return {
    previousPrice: previous.toFixed(2),
    amount: amount.toFixed(2),
    percent: ((amount / previous) * 100).toFixed(2),
    direction: amount > 0 ? "up" : "down",
  };
}
