import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

interface ResearchModel {
  id: number;
  label: string;
  own_url: string | null;
  primary_url: string | null;
  match_status: string;
  review_scope: string;
}

test("required source registry keeps exact matches separate from unresolved configurations", async () => {
  const registryPath = path.resolve(process.cwd(), "../../data/research/model-registry.json");
  const registry = JSON.parse(await readFile(registryPath, "utf8")) as { models: ResearchModel[] };
  const exact = registry.models.filter((model) => model.match_status === "точное совпадение");
  const unresolvedIds = new Set([2, 3, 10, 13, 15, 18, 20, 21, 24, 25, 26, 27]);

  assert.equal(registry.models.length, 29);
  assert.equal(registry.models.filter((model) => model.own_url).length, 28);
  assert.equal(exact.length, 17);
  assert.ok(exact.every((model) => model.primary_url));
  assert.ok(exact.every((model) => !model.review_scope.includes("полное совпадение не подтверждено")));
  assert.ok(registry.models.filter((model) => unresolvedIds.has(model.id)).every((model) => model.match_status !== "точное совпадение"));
});
