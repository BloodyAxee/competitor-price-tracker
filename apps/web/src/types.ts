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
  source: {
    name: string;
    sourceType: string;
    officialStatus: string;
  };
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
