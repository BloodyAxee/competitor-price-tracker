import assert from "node:assert/strict";
import test from "node:test";
import { calculatePriceMovement } from "./price-movement.ts";

test("price movement is calculated against the previous observation", () => {
  assert.deepEqual(calculatePriceMovement("120000", "100000"), {
    previousPrice: "100000.00",
    amount: "20000.00",
    percent: "20.00",
    direction: "up",
  });
  assert.equal(calculatePriceMovement("90000", "100000")?.direction, "down");
});

test("unchanged prices are distinct from a missing previous observation", () => {
  assert.deepEqual(calculatePriceMovement("100000", "100000"), {
    previousPrice: "100000.00",
    amount: "0.00",
    percent: "0.00",
    direction: "unchanged",
  });
  assert.equal(calculatePriceMovement("100000", null), null);
  assert.equal(calculatePriceMovement("bad", "100000"), null);
});
