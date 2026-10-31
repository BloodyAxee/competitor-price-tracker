import type { CatalogResponse, CatalogSummary } from "./types";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api";

async function request<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBase}${path}`);
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return response.json() as Promise<T>;
}

export function loadCatalog() {
  return Promise.all([
    request<CatalogSummary>("/catalog/summary"),
    request<CatalogResponse>("/products?limit=500"),
  ]);
}
