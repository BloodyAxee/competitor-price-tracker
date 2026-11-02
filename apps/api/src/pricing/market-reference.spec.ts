import assert from "node:assert/strict";
import test from "node:test";
import { calculateMarketReferenceDifference } from "./market-reference.ts";

const own = {
  rawPrice: null,
  normalizedPrice: { toString: () => "2000000" },
  priceType: "retail",
  unit: "piece",
};

test("comparable retail price gets a clearly separate reference difference", () => {
  assert.deepEqual(
    calculateMarketReferenceDifference(own, {
      rawPrice: { toString: () => "1800000" },
      normalizedPrice: null,
      priceType: "retail",
      unit: "piece",
    }),
    { amount: "-200000.00", percent: "-10.00" },
  );
});

test("missing, differently typed and differently normalized prices are not compared", () => {
  assert.equal(calculateMarketReferenceDifference(own, null), null);
  assert.equal(
    calculateMarketReferenceDifference(own, {
      rawPrice: { toString: () => "1800000" },
      normalizedPrice: null,
      priceType: "sale",
      unit: "piece",
    }),
    null,
  );
  assert.equal(
    calculateMarketReferenceDifference(own, {
      rawPrice: { toString: () => "1800000" },
      normalizedPrice: null,
      priceType: "retail",
      unit: "set",
    }),
    null,
  );
});
