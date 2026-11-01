import type { CollectionJob, ComparisonItem, CompetitorComparison, PriceObservation } from "./types";

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
  const priced = item.competitors.filter((offer) => offer.price?.normalizedPrice != null);
  if (priced.length === 0) return item.competitors[0] ?? null;
  return [...priced].sort(
    (left, right) => Number(left.price?.normalizedPrice) - Number(right.price?.normalizedPrice),
  )[0];
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

export function observationStatus(price: PriceObservation | null | undefined) {
  if (!price) return "Нет цены";
  if (price.reliability !== "valid") return "Не участвует в сравнении";
  if (price.method === "manual") return "Внесено вручную";
  return "Собрано автоматически";
}

export function jobLabel(job: Pick<CollectionJob, "status"> | null) {
  if (!job) return "Запустить сбор";
  if (job.status === "pending") return "Сбор ожидает запуска";
  if (job.status === "running") return "Идёт сбор цен";
  if (job.status === "success") return "Сбор завершён";
  if (job.status === "partial_success") return "Сбор завершён частично";
  return "Сбор завершился с ошибкой";
}
