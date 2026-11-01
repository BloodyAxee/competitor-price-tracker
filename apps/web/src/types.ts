export interface CatalogSummary {
  total: number;
  required: number;
  additional: number;
  ownUrls: number;
  exactOffers: number;
  reviewOffers: number;
}

export interface Offer {
  id: string;
  competitorUrl: string;
  sellerArticle: string | null;
  matchStatus: "exact" | "review" | "rejected";
  matchReason: string | null;
  seller: { displayName: string };
  source: { name: string; sourceType: string; officialStatus: string };
}

export interface Product {
  id: string;
  externalKey: string;
  name: string;
  brand: string | null;
  article: string | null;
  ownUrl: string | null;
  catalogScope: "required" | "additional" | "component";
  priority: number;
  offers: Offer[];
  bundleParts: Array<{
    quantity: string;
    componentProduct: { id: string; name: string; article: string | null };
  }>;
}

export interface CatalogResponse {
  total: number;
  items: Product[];
  limit: number;
  offset: number;
}

export interface PriceObservation {
  id: string;
  rawPrice: string | null;
  normalizedPrice: string | null;
  currency: string;
  unit: string | null;
  priceType: string;
  vatIncluded: boolean | null;
  stockStatus: string | null;
  region: string | null;
  deliveryIncluded: boolean | null;
  installationIncluded: boolean | null;
  observedAt: string | null;
  receivedAt: string;
  method: "automatic" | "manual" | string;
  reliability: "valid" | "unreliable" | string;
  exclusionReason: string | null;
  evidenceText: string | null;
}

export interface ComparisonOffer {
  offerId: string;
  url: string;
  seller: string;
  source: {
    externalKey: string;
    name: string;
    domain: string;
    sourceType: string;
    officialStatus: string;
  };
  matchStatus: "exact" | "review";
  matchReason: string | null;
  isOwn: boolean;
  price: PriceObservation | null;
  priceChange: {
    previousPrice: string;
    amount: string;
    percent: string;
    direction: "up" | "down";
  } | null;
  comparisonPrice: PriceObservation | null;
}

export interface CompetitorComparison extends ComparisonOffer {
  difference: { amount: string | null; percent: string | null };
}

export interface ComparisonItem {
  product: Pick<Product, "id" | "externalKey" | "name" | "article" | "ownUrl" | "catalogScope">;
  own: ComparisonOffer | null;
  competitors: CompetitorComparison[];
  bundleStatus: {
    ready: boolean;
    exclusionReason: "incomplete_bundle" | "mixed_sellers" | "mixed_price_types" | null;
  } | null;
}

export interface ComparisonResponse {
  total: number;
  items: ComparisonItem[];
  limit: number;
  offset: number;
}

export interface HistoryItem extends PriceObservation {
  offer: {
    competitorUrl: string;
    seller: { displayName: string };
    source: { externalKey: string; name: string; domain: string };
  };
  job: { id: string; triggerType: string; status: string } | null;
}

export interface HistoryResponse {
  product: { id: string; name: string };
  total: number;
  items: HistoryItem[];
  limit: number;
  offset: number;
}

export interface JobSummaryData {
  status?: string;
  total?: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  observations?: number;
  [key: string]: unknown;
}

export interface CollectionJob {
  id: string;
  jobKey: string | null;
  triggerType: string;
  status: "pending" | "running" | "partial_success" | "success" | "failed";
  scheduledFor: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: JobSummaryData | null;
  createdAt: string;
  attempts?: number;
  observations?: number;
}

export interface CollectionAttempt {
  id: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  source: { externalKey: string; name: string };
  offer: { competitorUrl: string; product: { id: string; name: string } } | null;
  observations: Array<{ id: string; reliability: string }>;
}

export interface CollectionJobDetails extends Omit<CollectionJob, "attempts"> {
  attempts: CollectionAttempt[];
}

export interface CollectionSchedule {
  cron: string;
  timeZone: string;
}

export interface ManualObservationInput {
  offerId: string;
  rawPrice: string;
  priceType: "rrp" | "retail" | "sale" | "quote" | "unknown";
  stockStatus?: string;
  evidenceText?: string;
  comment?: string;
}
