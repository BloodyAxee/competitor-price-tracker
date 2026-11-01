import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

interface ResearchModel {
  id: number;
  label: string;
  own_url: string | null;
  primary_url: string | null;
  reserve_url?: string | null;
  verified_exact_urls?: string[];
  match_status: string;
  review_scope: string;
  current_price_verified: boolean;
  automated_collection_verified: boolean;
}

interface BundleOffer {
  bundle_model: string;
  seller_domain: string;
  components: Array<{ article: string; url: string }>;
}

test("required source registry keeps exact matches separate from unresolved configurations", async () => {
  const registryPath = path.resolve(process.cwd(), "../../data/research/model-registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as {
    models: ResearchModel[];
    bundle_offers: BundleOffer[];
  };
  const exact = registry.models.filter((model) => model.match_status === "точное совпадение");
  const unresolvedIds = new Set([2, 15, 18, 24, 26, 27]);
  const newlyVerifiedIds = new Set([3, 10, 13, 20, 21, 25]);
  const recoveredNordbergIds = new Set([6, 7, 11, 28]);

  assert.equal(registry.models.length, 29);
  assert.equal(registry.models.filter((model) => model.own_url).length, 28);
  assert.equal(exact.length, 23);
  assert.ok(exact.every((model) => model.primary_url));
  assert.ok(exact.every((model) => !model.review_scope.includes("полное совпадение не подтверждено")));
  assert.ok(registry.models.filter((model) => unresolvedIds.has(model.id)).every((model) => model.match_status !== "точное совпадение"));
  assert.ok(
    registry.models
      .filter((model) => newlyVerifiedIds.has(model.id))
      .every(
        (model) =>
          model.match_status === "точное совпадение" &&
          model.current_price_verified &&
          model.automated_collection_verified,
      ),
  );
  assert.ok(
    registry.models
      .filter((model) => recoveredNordbergIds.has(model.id))
      .every(
        (model) =>
          model.primary_url !== null &&
          new URL(model.primary_url).hostname === "nordberg-shop.ru" &&
          model.current_price_verified &&
          model.automated_collection_verified,
      ),
  );
  assert.ok(
    registry.models.every((model) =>
      (model.verified_exact_urls ?? []).every(
        (url) => model.match_status === "точное совпадение" && url === model.reserve_url,
      ),
    ),
  );
  assert.equal(registry.bundle_offers.length, 1);
  assert.equal(registry.bundle_offers[0]?.bundle_model, "Шиномонтажный комплект NORDBERG 4641N + VT-64");
  assert.deepEqual(
    registry.bundle_offers[0]?.components.map((component) => component.article).sort(),
    ["4641N", "VT-64.5005"],
  );
  assert.ok(
    registry.bundle_offers[0]?.components.every(
      (component) => new URL(component.url).hostname.replace(/^www\./, "") === registry.bundle_offers[0]?.seller_domain,
    ),
  );
});
