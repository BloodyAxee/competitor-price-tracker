import assert from "node:assert/strict";
import test from "node:test";
import { evaluateManualPrice, type ManualPriceCandidate } from "./manual-price.ts";

const base: ManualPriceCandidate = {
  rawPrice: "95000",
  quantity: "1",
  priceType: "retail",
  isFromPrice: false,
  isStale: false,
  packageHomogeneous: true,
};

test("exact manual price is normalized without losing the manual audit path", () => {
  assert.deepEqual(evaluateManualPrice("exact", base), {
    normalizedPrice: "95000.00",
    reliability: "valid",
    exclusionReason: null,
  });
});

test("non-exact and quote inputs are retained but excluded", () => {
  assert.equal(evaluateManualPrice("review", base).exclusionReason, "non_exact_product");
  assert.equal(
    evaluateManualPrice("exact", { ...base, priceType: "quote" }).exclusionReason,
    "quote_only",
  );
});

test("comparable manual price is normalized as a market reference only", () => {
  assert.deepEqual(evaluateManualPrice("comparable", base), {
    normalizedPrice: "95000.00",
    reliability: "review",
    exclusionReason: "comparable_product",
  });
});

test("homogeneous packages are normalized and heterogeneous sets are not divided", () => {
  assert.equal(
    evaluateManualPrice("exact", { ...base, rawPrice: "3000", quantity: "3" })
      .normalizedPrice,
    "1000.00",
  );
  assert.equal(
    evaluateManualPrice("exact", {
      ...base,
      quantity: "2",
      packageHomogeneous: false,
    }).exclusionReason,
    "heterogeneous_package",
  );
});

test("invalid package quantity remains an auditable unreliable observation", () => {
  assert.equal(
    evaluateManualPrice("exact", { ...base, quantity: "0" }).exclusionReason,
    "invalid_package_quantity",
  );
});
