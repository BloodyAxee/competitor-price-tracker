import type {
  CatalogResponse,
  CatalogSummary,
  CollectionJob,
  CollectionJobDetails,
  CollectionSchedule,
  ComparisonResponse,
  HistoryResponse,
  ManualObservationInput,
} from "./types";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3000/api";

export const priceExportUrl = `${apiBase}/export.csv`;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) throw new Error(`API returned ${response.status}`);
  return response.json() as Promise<T>;
}

export function loadDashboard() {
  return Promise.all([
    request<CatalogSummary>("/catalog/summary"),
    request<CatalogResponse>("/products?limit=500"),
    request<ComparisonResponse>("/comparisons?limit=500"),
    request<CollectionSchedule>("/collection-schedule"),
  ]);
}

export function startCollection() {
  return request<CollectionJob>("/collection-jobs", { method: "POST" });
}

export function loadCollectionJob(id: string) {
  return request<CollectionJobDetails>(`/collection-jobs/${id}`);
}

export function loadHistory(productId: string) {
  return request<HistoryResponse>(`/products/${productId}/history?limit=100`);
}

export function addManualObservation(input: ManualObservationInput) {
  return request<{ jobId: string; observation: { reliability: string; exclusionReason: string | null } }>(
    "/manual-observations",
    { method: "POST", body: JSON.stringify(input) },
  );
}
