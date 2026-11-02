import re
import unicodedata
from dataclasses import replace
from decimal import Decimal

from .model import (
    CollectionMethod,
    MatchStatus,
    PriceDecision,
    PriceInput,
    PriceType,
    Reliability,
)


def parse_money(value: str) -> Decimal:
    normalized = unicodedata.normalize("NFKC", value).casefold().strip()
    if normalized.startswith("от"):
        raise ValueError("A 'from' price must be marked explicitly")

    without_currency = re.sub(r"(?:₽|руб\.?|rub|rur)", "", normalized)
    compact = re.sub(r"\s+", "", without_currency)
    if not re.fullmatch(r"\d+(?:[.,]\d{1,2})?", compact):
        raise ValueError(f"Unsupported money value: {value!r}")

    amount = Decimal(compact.replace(",", "."))
    if amount <= 0:
        raise ValueError("Money value must be positive")
    return amount


def _decision(
    candidate: PriceInput,
    reliability: Reliability,
    reason: str | None,
    normalized_price: Decimal | None = None,
) -> PriceDecision:
    return PriceDecision(
        raw_price=candidate.raw_price,
        normalized_price=normalized_price,
        price_type=candidate.price_type,
        method=candidate.method,
        reliability=reliability,
        exclusion_reason=reason,
        currency=candidate.currency,
        vat_included=candidate.vat_included,
        stock_status=candidate.stock_status,
        region=candidate.region,
        delivery_included=candidate.delivery_included,
        installation_included=candidate.installation_included,
    )


def evaluate_price(candidate: PriceInput, match_status: MatchStatus) -> PriceDecision:
    if candidate.price_type is PriceType.QUOTE:
        return _decision(candidate, Reliability.UNRELIABLE, "quote_only")
    if candidate.raw_price is None:
        return _decision(candidate, Reliability.UNRELIABLE, "missing_price")
    if candidate.raw_price <= 0:
        return _decision(candidate, Reliability.UNRELIABLE, "invalid_price")
    if match_status not in (MatchStatus.EXACT, MatchStatus.COMPARABLE):
        return _decision(candidate, Reliability.UNRELIABLE, "non_exact_product")
    if candidate.is_from_price:
        return _decision(candidate, Reliability.UNRELIABLE, "price_from")
    if candidate.is_stale:
        return _decision(candidate, Reliability.UNRELIABLE, "stale_page")
    if candidate.price_type is PriceType.UNKNOWN:
        return _decision(candidate, Reliability.REVIEW, "unknown_price_type")
    if candidate.package_quantity is None:
        return _decision(candidate, Reliability.REVIEW, "unknown_package_quantity")
    if candidate.package_quantity <= 0:
        return _decision(candidate, Reliability.UNRELIABLE, "invalid_package_quantity")
    if not candidate.package_homogeneous and candidate.package_quantity != Decimal("1"):
        return _decision(candidate, Reliability.UNRELIABLE, "heterogeneous_package")

    normalized_price = candidate.raw_price / candidate.package_quantity
    if match_status is MatchStatus.COMPARABLE:
        return _decision(
            candidate,
            Reliability.REVIEW,
            "comparable_product",
            normalized_price,
        )
    return _decision(candidate, Reliability.RELIABLE, None, normalized_price)


def evaluate_manual_price(candidate: PriceInput, match_status: MatchStatus) -> PriceDecision:
    return evaluate_price(replace(candidate, method=CollectionMethod.MANUAL), match_status)
