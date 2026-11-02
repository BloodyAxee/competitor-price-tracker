import type {
  CollectionAttempt,
  CollectionJob,
  CollectionMode,
  ComparisonItem,
  ComparisonOffer,
  CompetitorComparison,
  HistoryItem,
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

export function bestComparable(item: ComparisonItem): CompetitorComparison | null {
  return [...item.competitors]
    .filter(
      (offer) =>
        offer.matchStatus === "comparable" && observedPriceValue(offer.referencePrice) != null,
    )
    .sort((left, right) => {
      const levelDifference =
        (left.comparisonProfile?.level === "close" ? 0 : 1) -
        (right.comparisonProfile?.level === "close" ? 0 : 1);
      if (levelDifference !== 0) return levelDifference;
      return (
        Number(observedPriceValue(left.referencePrice) ?? Infinity) -
        Number(observedPriceValue(right.referencePrice) ?? Infinity)
      );
    })[0] ?? null;
}

export function attentionCompetitor(item: ComparisonItem): CompetitorComparison | null {
  return sortedCompetitors(item)
    .filter(
      (offer) =>
        observedPriceValue(offer.price) != null &&
        (offer.matchStatus === "review" ||
          (offer.matchStatus !== "comparable" && offer.price?.reliability !== "valid")),
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
  if (change.direction === "unchanged") return "Без изменений";
  const direction = change.direction === "up" ? "Выросла" : "Снизилась";
  return `${direction} на ${moneyFormatter.format(amount)} · ${percent.toFixed(1)}%`;
}

const collectionErrorLabels: Record<string, string> = {
  adapter_not_registered: "Для этого источника ещё не настроен автоматический сбор",
  all_extractors_failed: "Не удалось распознать данные на странице",
  ambiguous_price: "На странице найдено несколько цен, и нельзя безопасно выбрать одну",
  ambiguous_product: "На странице найдено несколько товаров, и нельзя подтвердить нужную модель",
  browser_error: "Браузер не смог обработать страницу",
  browser_timeout: "Сайт не успел ответить через браузер",
  circuit_breaker_open: "Сбор с этого сайта остановлен после повторных одинаковых ошибок",
  collection_error: "Источник не удалось обработать",
  conflicting_product_specification: "Характеристики на странице противоречат ожидаемой комплектации",
  http_error: "Страница вернула постоянную ошибку",
  human_verification_required: "Сайт запросил проверку человеком",
  invalid_price: "На странице найдено некорректное значение цены",
  missing_embedded_product: "На странице не найдены данные карточки товара",
  missing_price: "На странице не найдена опубликованная цена",
  missing_product_name: "На странице не найдено название товара",
  missing_product_specification: "На странице недостаточно характеристик для подтверждения товара",
  network_error: "Не удалось установить соединение с сайтом",
  network_timeout: "Сайт не ответил вовремя",
  parse_error: "Структура страницы изменилась, данные распознать не удалось",
  product_mismatch: "Карточка относится к другой модели или комплектации",
  protected_source: "Сайт ограничил автоматический доступ",
  source_cooldown: "Нестабильный резервный источник временно пропущен",
  source_mismatch: "Ответ получен не от ожидаемого источника",
  temporary_http_error: "Сайт временно недоступен",
  unexpected_error: "Во время сбора произошла техническая ошибка",
  unsupported_currency: "Цена указана в неподдерживаемой валюте",
  unsupported_offer: "Предложение не подходит для безопасного сравнения",
};

export function collectionErrorLabel(code: string | null | undefined, message?: string | null) {
  if (code && collectionErrorLabels[code]) return collectionErrorLabels[code];
  if (message && /[А-Яа-яЁё]/.test(message)) return message;
  return "Источник недоступен по технической причине";
}

const exclusionReasonLabels: Record<string, string> = {
  comparable_product: "Это сопоставимый рыночный ориентир, а не точное совпадение",
  heterogeneous_package: "В комплект входят разные товары, поэтому цену нельзя делить на количество",
  invalid_package_quantity: "Указано некорректное количество товара в упаковке",
  invalid_price: "Получено некорректное значение цены",
  missing_price: "Опубликованная цена не найдена",
  non_exact_product: "Модель или существенная комплектация не подтверждены как точное совпадение",
  price_from: "На странице указана цена «от», а не фиксированная стоимость",
  quote_only: "Цена доступна только по запросу",
  stale_page: "Цена опубликована на устаревшей странице",
  unknown_package_quantity: "Не удалось подтвердить количество товара в упаковке",
  unknown_price_type: "Не удалось определить тип опубликованной цены",
};

export function exclusionReasonLabel(reason: string | null | undefined) {
  if (!reason) return null;
  return exclusionReasonLabels[reason] ?? "Цена сохранена для истории, но не прошла правила итогового сравнения";
}

function humanizeResearchText(value: string) {
  return value
    .replaceAll("browser_timeout", "ошибкой ожидания ответа сайта")
    .replaceAll("browser timeout", "ошибкой ожидания ответа сайта")
    .replaceAll("AutoService2", "АВТОСЕРВИС2")
    .replaceAll("live-сбора", "контрольного автоматического сбора")
    .replaceAll("live-сбор", "контрольный автоматический сбор")
    .replace(/\breview\b/gi, "требующий проверки")
    .replace(/\bexact\b/gi, "точный");
}

export function competitorDescription(reason: string | null | undefined) {
  if (!reason) return [];
  const sentences = humanizeResearchText(reason)
    .split(/(?<=\.)\s+/)
    .map((sentence) => sentence.trim().replace(/\.$/, ""))
    .filter(Boolean);
  if (sentences.length === 1) return [{ label: "Описание", text: sentences[0] }];

  const role = sentences.shift()!;
  const basis = sentences.shift();
  const result = [{ label: "Роль источника", text: role }];
  if (basis) {
    const limitation = /защищ|тайм-аут|не используется|не должна|не подтвержд/i.test(basis);
    result.push({ label: limitation ? "Ограничение" : "Почему карточка подходит", text: basis });
  }
  if (sentences.length > 0) {
    result.push({ label: "Комментарий исследования", text: sentences.join(". ") });
  }
  return result;
}

export function historyPriceMovement(items: HistoryItem[], index: number) {
  const current = items[index];
  if (!current?.normalizedPrice) return null;
  const previous = items
    .slice(index + 1)
    .find(
      (candidate) =>
        candidate.offer.competitorUrl === current.offer.competitorUrl &&
        candidate.regionCode === current.regionCode,
    );
  if (!previous?.normalizedPrice) return null;
  const currentPrice = Number(current.normalizedPrice);
  const previousPrice = Number(previous.normalizedPrice);
  if (!Number.isFinite(currentPrice) || !Number.isFinite(previousPrice) || previousPrice <= 0) {
    return null;
  }
  const amount = currentPrice - previousPrice;
  return {
    previousPrice: previousPrice.toFixed(2),
    amount: amount.toFixed(2),
    percent: ((amount / previousPrice) * 100).toFixed(2),
    direction: amount === 0 ? "unchanged" as const : amount > 0 ? "up" as const : "down" as const,
  };
}

export interface CollectionOfferResult {
  key: string;
  status: "success" | "failed" | "skipped";
  source: CollectionAttempt["source"];
  offer: CollectionAttempt["offer"];
  attempts: CollectionAttempt[];
}

export function summarizeCollectionAttempts(
  attempts: CollectionAttempt[],
): CollectionOfferResult[] {
  const groups = new Map<string, CollectionAttempt[]>();
  for (const attempt of attempts) {
    const key = attempt.offer?.id ?? `${attempt.source.externalKey}:${attempt.id}`;
    const current = groups.get(key) ?? [];
    current.push(attempt);
    groups.set(key, current);
  }

  return [...groups].map(([key, groupedAttempts]) => {
    const status = groupedAttempts.some((attempt) => attempt.status === "success")
      ? "success"
      : groupedAttempts.some((attempt) => attempt.status === "failed")
        ? "failed"
        : "skipped";
    const lastAttempt = groupedAttempts.at(-1)!;
    return {
      key,
      status,
      source: lastAttempt.source,
      offer: lastAttempt.offer,
      attempts: groupedAttempts,
    };
  });
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
  if (offer.matchStatus === "comparable") {
    return offer.comparisonProfile?.level === "close" ? "Близкий аналог" : "Рыночный аналог";
  }
  if (offer.matchStatus === "review") return "Требует проверки";
  if (offer.price && offer.price.reliability !== "valid") return "Сомнительная цена";
  if (offer.comparisonPrice?.normalizedPrice != null) return "Подтверждено";
  return "Цена недоступна";
}

export function offerStatusTone(offer: ComparisonOffer) {
  if (offer.matchStatus === "comparable") return "comparable";
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

export function collectionModeLabel(mode: CollectionMode) {
  return mode === "fast" ? "Быстрый сбор" : "Полный сбор";
}
