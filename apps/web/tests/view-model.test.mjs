import assert from "node:assert/strict";
import test from "node:test";
import {
  bestCompetitor,
  competitorPriceCountLabel,
  differenceTone,
  formatDifference,
  formatPrice,
  observationStatus,
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
      { price: { normalizedPrice: "110000" } },
      { price: { normalizedPrice: "95000" } },
      { price: null },
    ],
  };
  assert.equal(bestCompetitor(item).price.normalizedPrice, "95000");
});

test("all competitors are kept and priced offers are ordered before unavailable ones", () => {
  const item = {
    competitors: [
      { seller: "Без цены", price: null },
      { seller: "Дороже", price: { normalizedPrice: "110000" } },
      { seller: "Дешевле", price: { normalizedPrice: "95000" } },
    ],
  };

  assert.deepEqual(
    sortedCompetitors(item).map((offer) => offer.seller),
    ["Дешевле", "Дороже", "Без цены"],
  );
});

test("competitor price count is displayed in natural Russian", () => {
  assert.equal(competitorPriceCountLabel(1), "1 цена конкурента");
  assert.equal(competitorPriceCountLabel(3), "3 цены конкурентов");
  assert.equal(competitorPriceCountLabel(5), "5 цен конкурентов");
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
