export const PRICE_EXPORT_HEADERS = [
  "model",
  "nash_url",
  "konkurent",
  "konkurent_url",
  "cena",
  "cena_za",
  "data_sbora",
  "sposob",
  "nadezhnost",
  "kommentariy",
] as const;

export type PriceExportHeader = (typeof PRICE_EXPORT_HEADERS)[number];
export type PriceExportRow = Record<PriceExportHeader, string>;

const UTF8_BOM = "\uFEFF";

function escapeCsvCell(value: string) {
  if (!/[",\r\n]/.test(value)) return value;
  return `"${value.replaceAll('"', '""')}"`;
}

export function exportMethod(method: string) {
  return method === "manual" ? "ruchnoy" : "avto";
}

export function exportReliability(reliability: string) {
  if (reliability === "valid") return "nadezhno";
  if (reliability === "review") return "trebuet_proverki";
  return "somnitelnyy";
}

export function createPriceCsv(rows: PriceExportRow[]) {
  const lines = [
    PRICE_EXPORT_HEADERS.join(","),
    ...rows.map((row) => PRICE_EXPORT_HEADERS.map((header) => escapeCsvCell(row[header])).join(",")),
  ];
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
}
