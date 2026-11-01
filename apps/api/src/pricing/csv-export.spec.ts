import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "csv-parse/sync";
import {
  createPriceCsv,
  exportMethod,
  exportReliability,
  PRICE_EXPORT_HEADERS,
  type PriceExportRow,
} from "./csv-export.ts";

test("price export keeps the exact required headers and survives a UTF-8 round trip", () => {
  const row: PriceExportRow = {
    model: 'Станок "Тест", 380 В',
    nash_url: "https://centr-to.ru/test",
    konkurent: "ООО «Конкурент»",
    konkurent_url: "https://example.test/item",
    cena: "95000.00",
    cena_za: "1 шт.",
    data_sbora: "2026-11-01T09:15:00.000Z",
    sposob: "ruchnoy",
    nadezhnost: "somnitelnyy",
    kommentariy: 'Проверено вручную, строка 1\nстрока "2"',
  };

  const csv = createPriceCsv([row]);
  const parsed = parse(csv, { bom: true, columns: true, skip_empty_lines: true }) as PriceExportRow[];

  assert.deepEqual(Object.keys(parsed[0]), [...PRICE_EXPORT_HEADERS]);
  assert.deepEqual(parsed, [row]);
});

test("method and reliability use the values agreed in the task", () => {
  assert.equal(exportMethod("automatic"), "avto");
  assert.equal(exportMethod("manual"), "ruchnoy");
  assert.equal(exportReliability("valid"), "nadezhno");
  assert.equal(exportReliability("review"), "trebuet_proverki");
  assert.equal(exportReliability("unreliable"), "somnitelnyy");
});
