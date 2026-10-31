import { createHash } from "node:crypto";
import { parse } from "csv-parse/sync";

export interface RequiredCatalogRow {
  model: string;
  ownUrl: string | null;
}

export interface AdditionalCatalogRow {
  model: string;
  article: string | null;
}

function parseRows(content: string, expectedHeaders: string[]): string[][] {
  const records = parse(content, {
    bom: true,
    skip_empty_lines: true,
    relax_column_count: false,
  }) as string[][];

  const headers = records.shift();
  if (!headers || headers.join("\u0000") !== expectedHeaders.join("\u0000")) {
    throw new Error(`Expected CSV headers ${expectedHeaders.join(",")}`);
  }

  for (const [index, record] of records.entries()) {
    if (record.length !== expectedHeaders.length) {
      throw new Error(`CSV row ${index + 2} has ${record.length} columns`);
    }
  }

  return records;
}

export function parseRequiredCatalog(content: string): RequiredCatalogRow[] {
  return parseRows(content, ["model", "url_na_nashem_sayte"]).map(
    ([model, ownUrl], index) => {
      const cleanModel = model?.trim();
      const cleanUrl = ownUrl?.trim() || null;

      if (!cleanModel) {
        throw new Error(`Required catalog row ${index + 2} has no model`);
      }
      if (cleanUrl && !/^https:\/\//.test(cleanUrl)) {
        throw new Error(`Required catalog row ${index + 2} has an invalid URL`);
      }

      return { model: cleanModel, ownUrl: cleanUrl };
    },
  );
}

export function parseAdditionalCatalog(content: string): AdditionalCatalogRow[] {
  return parseRows(content, ["model", "artikul"]).map(([model, article], index) => {
    const cleanModel = model?.trim();

    if (!cleanModel) {
      throw new Error(`Additional catalog row ${index + 2} has no model`);
    }

    return { model: cleanModel, article: article?.trim() || null };
  });
}

export function catalogExternalKey(
  scope: "required" | "additional",
  model: string,
  discriminator: string | null,
): string {
  const digest = createHash("sha256")
    .update(`${model.normalize("NFKC")}\u0000${discriminator?.normalize("NFKC") ?? ""}`)
    .digest("hex")
    .slice(0, 20);
  return `${scope}:${digest}`;
}

export function assertUniqueExternalKeys(
  rows: Array<{ model: string; discriminator: string | null }>,
  scope: "required" | "additional",
): void {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = catalogExternalKey(scope, row.model, row.discriminator);
    if (keys.has(key)) {
      throw new Error(`Duplicate catalog identity for ${row.model}`);
    }
    keys.add(key);
  }
}
