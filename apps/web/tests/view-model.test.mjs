import assert from "node:assert/strict";
import test from "node:test";
import {
  bestCompetitor,
  bestComparable,
  attentionCompetitor,
  collectionErrorLabel,
  collectionMethodLabel,
  collectionModeLabel,
  competitorPriceMovementState,
  competitorDescription,
  competitorCountLabel,
  confirmedPriceCountLabel,
  differenceTone,
  exclusionReasonLabel,
  formatDifference,
  formatPrice,
  formatPriceMovement,
  historyPriceMovement,
  hasConfirmedCompetitorPrice,
  observationStatus,
  observedPriceValue,
  offerStatusLabel,
  offerStatusTone,
  otherCompetitorsSummary,
  reliabilityLabel,
  requiresHumanVerification,
  sortedCompetitors,
  summarizeCollectionAttempts,
} from "../src/view-model.ts";

test("missing prices are never displayed as zero", () => {
  assert.equal(formatPrice(null), "Не собрано");
  assert.equal(formatPrice(undefined), "Не собрано");
  assert.equal(formatPrice(""), "Не собрано");
});

test("collection modes have distinct user-facing labels", () => {
  assert.equal(collectionModeLabel("fast"), "Быстрый сбор");
  assert.equal(collectionModeLabel("full"), "Полный сбор");
});

test("technical collection and exclusion codes have clear Russian labels", () => {
  assert.equal(collectionErrorLabel("browser_timeout"), "Сайт не успел ответить через браузер");
  assert.equal(
    collectionErrorLabel("circuit_breaker_open"),
    "Сбор с этого сайта остановлен после повторных одинаковых ошибок",
  );
  assert.equal(
    exclusionReasonLabel("non_exact_product"),
    "Модель или существенная комплектация не подтверждены как точное совпадение",
  );
  assert.equal(
    exclusionReasonLabel("comparable_product"),
    "Это сопоставимый рыночный ориентир, а не точное совпадение",
  );
});

test("long research notes are split into understandable labelled parts", () => {
  assert.deepEqual(
    competitorDescription(
      "Резервный источник. Совпадение подтверждено по модели и напряжению. AutoService2 добавлен после live-сбора. Карточка завершила browser timeout.",
    ),
    [
      { label: "Роль источника", text: "Резервный источник" },
      { label: "Почему карточка подходит", text: "Совпадение подтверждено по модели и напряжению" },
      {
        label: "Комментарий исследования",
        text: "АВТОСЕРВИС2 добавлен после контрольного автоматического сбора. Карточка завершила ошибкой ожидания ответа сайта",
      },
    ],
  );
});

test("an unverified observation displays its raw collected price", () => {
  assert.equal(
    observedPriceValue({ rawPrice: "149000", normalizedPrice: null, reliability: "unreliable" }),
    "149000",
  );
});

test("the cheapest priced competitor is selected", () => {
  const item = {
    competitors: [
      { comparisonPrice: { normalizedPrice: "110000" }, price: { normalizedPrice: "110000" } },
      { comparisonPrice: { normalizedPrice: "95000" }, price: { normalizedPrice: "95000" } },
      { comparisonPrice: null, price: null },
    ],
  };
  assert.equal(bestCompetitor(item).comparisonPrice.normalizedPrice, "95000");
});

test("confirmed price filter only accepts exact usable competitor prices", () => {
  assert.equal(
    hasConfirmedCompetitorPrice({
      competitors: [
        {
          seller: "Точный источник",
          comparisonPrice: { normalizedPrice: "100000" },
          price: { normalizedPrice: "100000" },
        },
      ],
    }),
    true,
  );
  assert.equal(
    hasConfirmedCompetitorPrice({
      competitors: [
        {
          seller: "Только ориентир",
          comparisonPrice: null,
          referencePrice: { normalizedPrice: "90000" },
          price: { normalizedPrice: "90000" },
        },
      ],
    }),
    false,
  );
});

test("price movement filter separates unchanged prices from missing history", () => {
  assert.equal(
    competitorPriceMovementState({
      competitors: [{ priceChange: { direction: "up" } }],
    }),
    "changed",
  );
  assert.equal(
    competitorPriceMovementState({
      competitors: [{ priceChange: { direction: "unchanged" } }],
    }),
    "unchanged",
  );
  assert.equal(
    competitorPriceMovementState({ competitors: [{ priceChange: null }] }),
    "unknown",
  );
});

test("the result price ignores a cheaper unverified offer", () => {
  const item = {
    own: {
      price: { normalizedPrice: "100000", reliability: "valid" },
      comparisonPrice: { normalizedPrice: "100000" },
    },
    competitors: [
      {
        seller: "Проверить",
        matchStatus: "review",
        price: { normalizedPrice: "80000", reliability: "unreliable" },
        comparisonPrice: null,
      },
      {
        seller: "Подтверждено",
        matchStatus: "exact",
        price: { normalizedPrice: "100000", reliability: "valid" },
        comparisonPrice: { normalizedPrice: "100000" },
      },
    ],
  };

  assert.equal(bestCompetitor(item).seller, "Подтверждено");
  assert.equal(attentionCompetitor(item).seller, "Проверить");
});

test("a comparable price is selected separately and never becomes the exact result", () => {
  const item = {
    competitors: [
      {
        seller: "Рыночный аналог",
        matchStatus: "comparable",
        comparisonProfile: { level: "market" },
        price: { rawPrice: "1400000", normalizedPrice: null, reliability: "unreliable" },
        referencePrice: { rawPrice: "1400000", normalizedPrice: null },
        referenceDifference: { amount: "-215000", percent: "-13.31" },
        comparisonPrice: null,
      },
    ],
  };

  assert.equal(bestCompetitor(item), null);
  assert.equal(bestComparable(item).seller, "Рыночный аналог");
  assert.equal(attentionCompetitor(item), null);
  assert.equal(offerStatusLabel(item.competitors[0]), "Рыночный аналог");
  assert.equal(offerStatusTone(item.competitors[0]), "comparable");
});

test("the table counts unverified competitors and compares their prices with CTO", () => {
  const item = {
    own: {
      price: { normalizedPrice: "149000", reliability: "valid" },
      comparisonPrice: { normalizedPrice: "149000" },
    },
    competitors: [
      {
        offerId: "review-equal",
        seller: "Проверить 1",
        matchStatus: "review",
        price: { normalizedPrice: "149000", reliability: "unreliable" },
        comparisonPrice: null,
      },
      {
        offerId: "review-different",
        seller: "Проверить 2",
        matchStatus: "review",
        price: { normalizedPrice: "160000", reliability: "unreliable" },
        comparisonPrice: null,
      },
      {
        offerId: "exact",
        seller: "Подтверждено",
        matchStatus: "exact",
        price: { normalizedPrice: "132500", reliability: "valid" },
        comparisonPrice: { normalizedPrice: "132500" },
      },
    ],
  };

  assert.deepEqual(otherCompetitorsSummary(item), {
    countLabel: "Ещё 2 конкурента",
    priceNote: "Есть цены выше и ниже ЦТО",
  });
});

test("a missing review price is never interpreted as zero", () => {
  const item = {
    own: {
      price: { normalizedPrice: "461250", reliability: "valid" },
      comparisonPrice: { normalizedPrice: "461250" },
    },
    competitors: [
      {
        seller: "Подтверждено",
        matchStatus: "exact",
        price: { normalizedPrice: "688900", reliability: "valid" },
        comparisonPrice: { normalizedPrice: "688900" },
      },
      {
        seller: "Без цены",
        matchStatus: "review",
        price: null,
        comparisonPrice: null,
      },
    ],
  };

  assert.deepEqual(otherCompetitorsSummary(item), {
    countLabel: "Ещё 1 конкурент",
    priceNote: "Цены пока не собраны",
  });
});

test("price movement is formatted as a separate market signal", () => {
  assert.equal(
    formatPriceMovement({ amount: "-10000", percent: "-10", direction: "down" }),
    "Снизилась на 10 000 ₽ · 10.0%",
  );
  assert.equal(
    formatPriceMovement({ amount: "0", percent: "0", direction: "unchanged" }),
    "Без изменений",
  );
  assert.equal(formatPriceMovement(null), null);
});

test("price movement in history uses the previous observation of the same offer and region", () => {
  const history = [
    { normalizedPrice: "90000", regionCode: null, offer: { competitorUrl: "https://seller.test/1" } },
    { normalizedPrice: "50000", regionCode: null, offer: { competitorUrl: "https://seller.test/2" } },
    { normalizedPrice: "100000", regionCode: "moscow", offer: { competitorUrl: "https://seller.test/1" } },
    { normalizedPrice: "100000", regionCode: null, offer: { competitorUrl: "https://seller.test/1" } },
  ];

  assert.deepEqual(historyPriceMovement(history, 0), {
    previousPrice: "100000.00",
    amount: "-10000.00",
    percent: "-10.00",
    direction: "down",
  });
  assert.equal(historyPriceMovement(history, 1), null);
  assert.equal(historyPriceMovement(history, 2), null);
});

test("collection retries are summarized by unique offer", () => {
  const source = { externalKey: "seller", name: "Продавец" };
  const offer = {
    id: "offer-1",
    competitorUrl: "https://example.test/product",
    product: { id: "product-1", name: "Модель" },
  };
  const attempts = [
    { id: "1", attemptNumber: 1, status: "failed", errorCode: "browser_timeout", source, offer, observations: [] },
    { id: "2", attemptNumber: 2, status: "failed", errorCode: "browser_timeout", source, offer, observations: [] },
    { id: "3", attemptNumber: 3, status: "success", errorCode: null, source, offer, observations: [{ id: "9", reliability: "valid" }] },
    { id: "4", attemptNumber: 1, status: "skipped", errorCode: "circuit_breaker_open", source, offer: { ...offer, id: "offer-2" }, observations: [] },
  ];

  assert.deepEqual(
    summarizeCollectionAttempts(attempts).map((result) => ({
      key: result.key,
      status: result.status,
      attempts: result.attempts.length,
    })),
    [
      { key: "offer-1", status: "success", attempts: 3 },
      { key: "offer-2", status: "skipped", attempts: 1 },
    ],
  );
});

test("human verification is requested only for protected collection results", () => {
  const base = {
    key: "offer-1",
    status: "skipped",
    source: { externalKey: "seller", name: "Продавец" },
    offer: null,
  };
  assert.equal(
    requiresHumanVerification({
      ...base,
      attempts: [{ errorCode: "human_verification_required" }],
    }),
    true,
  );
  assert.equal(
    requiresHumanVerification({
      ...base,
      attempts: [{ errorCode: "browser_timeout" }],
    }),
    false,
  );
});

test("all competitors are kept and priced offers are ordered before unavailable ones", () => {
  const item = {
    competitors: [
      { seller: "Без цены", comparisonPrice: null, price: null },
      { seller: "Дороже", comparisonPrice: { normalizedPrice: "110000" }, price: { normalizedPrice: "110000" } },
      { seller: "Дешевле", comparisonPrice: { normalizedPrice: "95000" }, price: { normalizedPrice: "95000" } },
    ],
  };

  assert.deepEqual(
    sortedCompetitors(item).map((offer) => offer.seller),
    ["Дешевле", "Дороже", "Без цены"],
  );
});

test("other competitor summary explains equal and different prices", () => {
  const equalPrices = {
    own: { price: { normalizedPrice: "72000" }, comparisonPrice: { normalizedPrice: "72000" } },
    competitors: [
      { seller: "Первый", comparisonPrice: { normalizedPrice: "72000" }, price: { normalizedPrice: "72000" } },
      { seller: "Второй", comparisonPrice: { normalizedPrice: "72000" }, price: { normalizedPrice: "72000" } },
      { seller: "Третий", comparisonPrice: { normalizedPrice: "72000" }, price: { normalizedPrice: "72000" } },
    ],
  };
  const differentPrices = {
    own: { price: { normalizedPrice: "72000" }, comparisonPrice: { normalizedPrice: "72000" } },
    competitors: [
      { seller: "Первый", comparisonPrice: { normalizedPrice: "72000" }, price: { normalizedPrice: "72000" } },
      { seller: "Второй", comparisonPrice: { normalizedPrice: "80000" }, price: { normalizedPrice: "80000" } },
      { seller: "Третий", comparisonPrice: { normalizedPrice: "90000" }, price: { normalizedPrice: "90000" } },
    ],
  };

  assert.deepEqual(otherCompetitorsSummary(equalPrices), {
    countLabel: "Ещё 2 конкурента",
    priceNote: "Доступные цены совпадают с ЦТО",
  });
  assert.deepEqual(otherCompetitorsSummary(differentPrices), {
    countLabel: "Ещё 2 конкурента",
    priceNote: "Есть цена выше ЦТО на 18 000 ₽",
  });
  assert.equal(otherCompetitorsSummary({ own: equalPrices.own, competitors: equalPrices.competitors.slice(0, 1) }), null);
});

test("competitor count is displayed in natural Russian", () => {
  assert.equal(competitorCountLabel(1), "1 конкурент");
  assert.equal(competitorCountLabel(3), "3 конкурента");
  assert.equal(competitorCountLabel(5), "5 конкурентов");
  assert.equal(confirmedPriceCountLabel(1), "1 подтверждённая цена");
  assert.equal(confirmedPriceCountLabel(3), "3 подтверждённые цены");
});

test("unreliable and review offers stay visible but are marked", () => {
  const review = { matchStatus: "review", price: null, comparisonPrice: null };
  const unreliable = {
    matchStatus: "exact",
    price: { reliability: "unreliable", method: "automatic" },
    comparisonPrice: null,
  };
  const valid = {
    matchStatus: "exact",
    price: { reliability: "valid", method: "manual" },
    comparisonPrice: { normalizedPrice: "100000" },
  };

  assert.equal(offerStatusLabel(review), "Требует проверки");
  assert.equal(offerStatusTone(unreliable), "warning");
  assert.equal(offerStatusLabel(valid), "Подтверждено");
  assert.equal(collectionMethodLabel(valid.price), "Внесено вручную");
});

test("difference tone follows the own-price perspective", () => {
  assert.equal(differenceTone("5000"), "positive");
  assert.equal(differenceTone("-5000"), "negative");
  assert.equal(differenceTone("0"), "neutral");
  assert.match(formatDifference("5000", "5.26"), /^\+/);
});

test("manual and unreliable observations are labelled explicitly", () => {
  assert.equal(observationStatus({ reliability: "valid", method: "manual" }), "Внесено вручную");
  assert.equal(
    observationStatus({ reliability: "unreliable", method: "manual" }),
    "Не участвует в сравнении",
  );
  assert.equal(
    reliabilityLabel({ reliability: "valid", method: "automatic" }),
    "Надёжно · автоматически",
  );
  assert.equal(reliabilityLabel(null), "Нет подтверждённой цены");
});
