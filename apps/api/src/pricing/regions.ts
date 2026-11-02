export const REGION_CODES = [
  "moscow",
  "saint-petersburg",
  "kazan",
  "yekaterinburg",
  "krasnodar",
  "novosibirsk",
  "khabarovsk",
] as const;

export type RegionCode = (typeof REGION_CODES)[number];

const regionNames: Record<RegionCode, string> = {
  moscow: "Москва",
  "saint-petersburg": "Санкт-Петербург",
  kazan: "Казань",
  yekaterinburg: "Екатеринбург",
  krasnodar: "Краснодар",
  novosibirsk: "Новосибирск",
  khabarovsk: "Хабаровск",
};

export function regionName(code: RegionCode) {
  return regionNames[code];
}

export function isRegionCode(value: string): value is RegionCode {
  return REGION_CODES.includes(value as RegionCode);
}
