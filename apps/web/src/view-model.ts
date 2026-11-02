import type {
  CollectionJob,
  ComparisonItem,
  ComparisonOffer,
  CompetitorComparison,
  PriceObservation,
} from "./types";

const moneyFormatter = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

export function formatPrice(value: string | null | undefined) {
  if (value == null || value.trim() === "") return "Не собрано";
  const numeric = Number(value);
  return Number.isFinite(numeric) ? moneyFormatter.format(numeric) : "Не указано";
}

export function observedPriceValue(price: PriceObservation | null | undefined) {
  return price?.normalizedPrice ?? price?.rawPrice ?? null;
}

export function formatDate(value: string | null | undefined, includeTime = true) {
  if (!value) return "Не указано";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Не указано";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "short",
    ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {}),
  }).format(date);
}

export function bestCompetitor(item: ComparisonItem): CompetitorComparison | null {
  return sortedCompetitors(item).find((offer) => offer.comparisonPrice?.normalizedPrice != null) ?? null;
}

export function attentionCompetitor(item: ComparisonItem): CompetitorComparison | null {
  return sortedCompetitors(item)
    .filter(
      (offer) =>
        observedPriceValue(offer.price) != null &&
        (offer.matchStatus === "review" || offer.price?.reliability !== "valid"),
    )[0] ?? null;
}

export function otherCompetitorsSummary(item: ComparisonItem) {
  const best = bestCompetitor(item);
  const others = item.competitors.filter((offer) => offer !== best);
  if (others.length === 0) return null;

  const countLabel = best
    ? `Ещё ${competitorCountLabel(others.length)}`
    : competitorCountLabel(others.length);
  const ownPrice = Number(item.own?.comparisonPrice?.normalizedPrice ?? item.own?.price?.normalizedPrice);
  if (!Number.isFinite(ownPrice) || ownPrice <= 0) return { countLabel, priceNote: null };

  const differences = others.flatMap((offer) => {
    const price = offer.comparisonPrice?.normalizedPrice ?? observedPriceValue(offer.price);
    if (price == null || price.trim() === "") return [];
    const numericPrice = Number(price);
    return Number.isFinite(numericPrice) && numericPrice > 0 ? [numericPrice - ownPrice] : [];
  });
  if (differences.length === 0) return { countLabel, priceNote: "Цены пока не собраны" };
  if (differences.every((difference) => difference === 0)) {
    return { countLabel, priceNote: "Доступные цены совпадают с ЦТО" };
  }

  const allLower = differences.every((difference) => difference < 0);
  const allHigher = differences.every((difference) => difference > 0);
  const largestDifference = Math.max(...differences.map((difference) => Math.abs(difference)));
  if (allLower) return { countLabel, priceNote: `Есть цена ниже ЦТО на ${moneyFormatter.format(largestDifference)}` };
  if (allHigher) return { countLabel, priceNote: `Есть цена выше ЦТО на ${moneyFormatter.format(largestDifference)}` };
  return { countLabel, priceNote: "Есть цены выше и ниже ЦТО" };
}

export function sortedCompetitors(item: ComparisonItem): CompetitorComparison[] {
  return [...item.competitors].sort((left, right) => {
    const leftPrice = left.comparisonPrice?.normalizedPrice ?? observedPriceValue(left.price);
    const rightPrice = right.comparisonPrice?.normalizedPrice ?? observedPriceValue(right.price);
    if (leftPrice != null && rightPrice != null) return Number(leftPrice) - Number(rightPrice);
    if (leftPrice != null) return -1;
    if (rightPrice != null) return 1;
    return left.seller.localeCompare(right.seller, "ru");
  });
}

export function differenceTone(value: string | null | undefined) {
  const numeric = Number(value);
  if (!value || !Number.isFinite(numeric) || numeric === 0) return "neutral";
  return numeric > 0 ? "positive" : "negative";
}

export function formatDifference(amount: string | null | undefined, percent: string | null | undefined) {
  if (amount == null || percent == null) return "Нет сравнения";
  const numericAmount = Number(amount);
  const numericPercent = Number(percent);
  if (!Number.isFinite(numericAmount) || !Number.isFinite(numericPercent)) return "Нет сравнения";
  const sign = numericAmount > 0 ? "+" : "";
  return `${sign}${moneyFormatter.format(numericAmount)} · ${sign}${numericPercent.toFixed(1)}%`;
}

export function formatPriceMovement(
  change: ComparisonOffer["priceChange"] | null | undefined,
) {
  if (!change) return null;
  const amount = Math.abs(Number(change.amount));
  const percent = Math.abs(Number(change.percent));
  if (!Number.isFinite(amount) || !Number.isFinite(percent)) return null;
  const direction = change.direction === "up" ? "Выросла" : "Снизилась";
  return `${direction} на ${moneyFormatter.format(amount)} · ${percent.toFixed(1)}%`;
}

export function observationStatus(price: PriceObservation | null | undefined) {
  if (!price) return "Нет цены";
  if (price.reliability !== "valid") return "Не участвует в сравнении";
  if (price.method === "manual") return "Внесено вручную";
  return "Собрано автоматически";
}

export function reliabilityLabel(price: PriceObservation | null | undefined) {
  if (!price) return "Нет подтверждённой цены";
  if (price.reliability !== "valid") return "Сомнительный источник";
  return price.method === "manual" ? "Надёжно · вручную" : "Надёжно · автоматически";
}

export function offerStatusLabel(offer: ComparisonOffer) {
  if (offer.matchStatus === "review") return "Требует проверки";
  if (offer.price && offer.price.reliability !== "valid") return "Сомнительная цена";
  if (offer.comparisonPrice?.normalizedPrice != null) return "Подтверждено";
  return "Цена недоступна";
}

export function offerStatusTone(offer: ComparisonOffer) {
  if (offer.matchStatus === "review" || (offer.price && offer.price.reliability !== "valid")) {
    return "warning";
  }
  return offer.comparisonPrice?.normalizedPrice != null ? "valid" : "missing";
}

export function collectionMethodLabel(price: PriceObservation | null | undefined) {
  if (!price) return "Цена ещё не собрана";
  return price.method === "manual" ? "Внесено вручную" : "Собрано автоматически";
}

export function competitorCountLabel(count: number) {
  if (count === 1) return "1 конкурент";
  if (count >= 2 && count <= 4) return `${count} конкурента`;
  return `${count} конкурентов`;
}

export function confirmedPriceCountLabel(count: number) {
  if (count === 1) return "1 подтверждённая цена";
  if (count >= 2 && count <= 4) return `${count} подтверждённые цены`;
  return `${count} подтверждённых цен`;
}

export function jobLabel(job: Pick<CollectionJob, "status"> | null) {
  if (!job) return "Запустить сбор";
  if (job.status === "pending") return "Сбор ожидает запуска";
  if (job.status === "running") return "Идёт сбор цен";
  if (job.status === "success") return "Сбор завершён";
  if (job.status === "partial_success") return "Сбор завершён частично";
  return "Сбор завершился с ошибкой";
}
