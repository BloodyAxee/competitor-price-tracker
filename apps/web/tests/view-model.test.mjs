import assert from "node:assert/strict";
import test from "node:test";
import {
  bestCompetitor,
  attentionCompetitor,
  collectionMethodLabel,
  competitorCountLabel,
  confirmedPriceCountLabel,
  differenceTone,
  formatDifference,
  formatPrice,
  formatPriceMovement,
  observationStatus,
  offerStatusLabel,
  offerStatusTone,
  reliabilityLabel,
  sortedCompetitors,
} from "../src/view-model.ts";

test("missing prices are never displayed as zero", () => {
  assert.equal(formatPrice(null), "Не собрано");
  assert.equal(formatPrice(undefined), "Не собрано");
  assert.equal(formatPrice(""), "Не собрано");
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

test("the result price ignores a cheaper unverified offer", () => {
  const item = {
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

test("price movement is formatted as a separate market signal", () => {
  assert.equal(
    formatPriceMovement({ amount: "-10000", percent: "-10", direction: "down" }),
    "Снизилась на 10 000 ₽ · 10.0%",
  );
  assert.equal(formatPriceMovement(null), null);
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
