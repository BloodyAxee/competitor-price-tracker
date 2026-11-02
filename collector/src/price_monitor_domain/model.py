from dataclasses import dataclass, field
from decimal import Decimal
from enum import StrEnum
from typing import Mapping


class MatchStatus(StrEnum):
    EXACT = "exact"
    COMPARABLE = "comparable"
    REVIEW = "review"
    UNRELIABLE = "unreliable"


class PriceType(StrEnum):
    RRP = "rrp"
    RETAIL = "retail"
    SALE = "sale"
    QUOTE = "quote"
    UNKNOWN = "unknown"


class CollectionMethod(StrEnum):
    AUTO = "auto"
    MANUAL = "manual"


class Reliability(StrEnum):
    RELIABLE = "reliable"
    REVIEW = "review"
    UNRELIABLE = "unreliable"


class OfficialStatus(StrEnum):
    MANUFACTURER = "manufacturer"
    OFFICIAL_DEALER = "official_dealer"
    VERIFIED_RETAILER = "verified_retailer"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class ProductIdentity:
    brand: str
    model: str
    article: str | None = None
    material_specs: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class MatchDecision:
    status: MatchStatus
    reason: str | None = None


@dataclass(frozen=True)
class PriceInput:
    raw_price: Decimal | None
    price_type: PriceType
    method: CollectionMethod = CollectionMethod.AUTO
    is_from_price: bool = False
    is_stale: bool = False
    package_quantity: Decimal | None = Decimal("1")
    package_homogeneous: bool = True
    currency: str = "RUB"
    vat_included: bool | None = None
    stock_status: str | None = None
    region: str | None = None
    region_code: str | None = None
    delivery_included: bool | None = None
    installation_included: bool | None = None


@dataclass(frozen=True)
class PriceDecision:
    raw_price: Decimal | None
    normalized_price: Decimal | None
    price_type: PriceType
    method: CollectionMethod
    reliability: Reliability
    exclusion_reason: str | None
    currency: str
    vat_included: bool | None
    stock_status: str | None
    region: str | None
    region_code: str | None
    delivery_included: bool | None
    installation_included: bool | None

    @property
    def eligible_for_comparison(self) -> bool:
        return self.reliability is Reliability.RELIABLE and self.normalized_price is not None


@dataclass(frozen=True)
class PricedOffer:
    source_id: str
    official_status: OfficialStatus
    price: PriceDecision


@dataclass(frozen=True)
class BundleComponent:
    component_id: str
    seller_id: str
    unit_price: Decimal
    quantity: Decimal = Decimal("1")


@dataclass(frozen=True)
class BundleDecision:
    normalized_price: Decimal | None
    reliability: Reliability
    exclusion_reason: str | None

    @property
    def eligible_for_comparison(self) -> bool:
        return self.reliability is Reliability.RELIABLE and self.normalized_price is not None
