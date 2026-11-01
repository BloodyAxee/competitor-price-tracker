import assert from "node:assert/strict";
import test from "node:test";
import { evaluateBundle, type BundleOffer, type BundlePart } from "./bundle-price.ts";

const source = {
  externalKey: "source:manual-bundle",
  name: "Ручная проверка компонентов комплекта",
  domain: "manual.bundle",
  sourceType: "manual",
  officialStatus: "unknown",
};

function offer(
  component: string,
  sellerId: string,
  price: string,
  priceType = "retail",
): BundleOffer {
  return {
    offerId: `${component}-${sellerId}`,
    sellerId,
    sellerName: sellerId,
    url: `https://manual.local/bundle/${component}`,
    source,
    observation: {
      normalizedPrice: price,
      currency: "RUB",
      priceType,
      method: "manual",
      receivedAt: new Date("2026-11-01T10:00:00Z"),
    },
  };
}

function parts(first: BundleOffer[], second: BundleOffer[]): BundlePart[] {
  return [
    { componentId: "4641N", quantity: "1", offers: first },
    { componentId: "VT-64.5005", quantity: "1", offers: second },
  ];
}

test("bundle sums both components only for the same seller", () => {
  const result = evaluateBundle(
    parts([offer("4641N", "seller-a", "210000")], [offer("VT-64", "seller-a", "90000")]),
  );

  assert.equal(result.exclusionReason, null);
  assert.equal(result.candidates[0]?.totalPrice, "300000.00");
  assert.equal(result.candidates[0]?.method, "manual");
});

test("prices from different sellers do not form a bundle", () => {
  const result = evaluateBundle(
    parts([offer("4641N", "seller-a", "210000")], [offer("VT-64", "seller-b", "90000")]),
  );

  assert.equal(result.exclusionReason, "mixed_sellers");
  assert.equal(result.candidates.length, 0);
});

test("missing component and mixed price types are explained", () => {
  assert.equal(
    evaluateBundle(parts([offer("4641N", "seller-a", "210000")], [])).exclusionReason,
    "incomplete_bundle",
  );
  assert.equal(
    evaluateBundle(
      parts(
        [offer("4641N", "seller-a", "210000", "retail")],
        [offer("VT-64", "seller-a", "90000", "rrp")],
      ),
    ).exclusionReason,
    "mixed_price_types",
  );
});
