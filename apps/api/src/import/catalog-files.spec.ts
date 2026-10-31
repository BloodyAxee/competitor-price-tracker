import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertUniqueExternalKeys,
  parseAdditionalCatalog,
  parseRequiredCatalog,
} from "./catalog-files.ts";

const dataRoot = path.resolve(process.cwd(), "../../data/input");

test("catalog CSV files keep the agreed counts and bundle inputs", async () => {
  const [requiredText, additionalText] = await Promise.all([
    readFile(path.join(dataRoot, "modeli.csv"), "utf8"),
    readFile(path.join(dataRoot, "modeli-dop.csv"), "utf8"),
  ]);
  const required = parseRequiredCatalog(requiredText);
  const additional = parseAdditionalCatalog(additionalText);

  assert.equal(required.length, 29);
  assert.equal(additional.length, 238);
  assert.equal(required.filter((row) => row.ownUrl).length, 28);
  assert.equal(
    required.find((row) => row.model.includes("4641N + VT-64"))?.ownUrl,
    null,
  );
  assert.ok(additional.some((row) => row.article === "4641N"));
  assert.ok(additional.some((row) => row.article === "VT-64.5005"));

  assertUniqueExternalKeys(
    required.map((row) => ({ model: row.model, discriminator: row.ownUrl })),
    "required",
  );
  assertUniqueExternalKeys(
    additional.map((row) => ({ model: row.model, discriminator: row.article })),
    "additional",
  );
});

test("quoted commas and unicode model names are parsed without damage", () => {
  const rows = parseRequiredCatalog(
    'model,url_na_nashem_sayte\n"ES-26D, 14–26″",https://example.test/model\n',
  );
  assert.deepEqual(rows, [
    { model: "ES-26D, 14–26″", ownUrl: "https://example.test/model" },
  ]);
});
