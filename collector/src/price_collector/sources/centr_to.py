import json
import re
import unicodedata
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from hashlib import sha256
from html import unescape
from html.parser import HTMLParser
from typing import Any, Protocol
from urllib.parse import urlsplit

from price_monitor_domain import MatchStatus, PriceInput, PriceType, evaluate_price, parse_money

from ..browser import PlaywrightFetcher
from ..errors import PermanentCollectionError
from ..http import HttpResponse
from ..models import CollectedObservation, SourceTask


SOURCE_KEY = "source:centr-to.ru"
EXPECTED_PRODUCT_ID = "15155"
EXPECTED_SPECS = {
    "напряжение питания, в": "380",
    "внешний зажим диска": '10-21"',
    "внутренний зажим диска": '12-24"',
    "максимальный диаметр шины, мм": "1140",
    "ширина колеса, мм": "355",
}


class PageFetcher(Protocol):
    def fetch(self, url: str, *, timeout: float, rate_limit_per_host: float) -> HttpResponse: ...


@dataclass(frozen=True)
class CentrToProduct:
    name: str
    price: Decimal
    currency: str
    availability: str | None
    specifications: dict[str, str]


class _JsonLdParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.blocks: list[str] = []
        self._buffer: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = {key.casefold(): value for key, value in attrs}
        if (
            tag.casefold() == "script"
            and (attributes.get("type") or "").casefold() == "application/ld+json"
        ):
            self._buffer = []

    def handle_data(self, data: str) -> None:
        if self._buffer is not None:
            self._buffer.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.casefold() == "script" and self._buffer is not None:
            self.blocks.append("".join(self._buffer))
            self._buffer = None


def _walk_products(value: Any) -> Iterator[dict[str, Any]]:
    if isinstance(value, dict):
        item_type = value.get("@type")
        types = item_type if isinstance(item_type, list) else [item_type]
        if any(str(candidate).casefold() == "product" for candidate in types):
            yield value
        for nested in value.values():
            yield from _walk_products(nested)
    elif isinstance(value, list):
        for nested in value:
            yield from _walk_products(nested)


def _normalized_text(value: Any) -> str:
    text = unicodedata.normalize("NFKC", unescape(str(value))).casefold()
    return " ".join(text.replace("–", "-").replace("—", "-").replace("″", '"').split())


def _product_specs(product: dict[str, Any]) -> dict[str, str]:
    properties = product.get("additionalProperty")
    if not isinstance(properties, list):
        raise PermanentCollectionError(
            "Product specifications are missing",
            code="missing_product_specifications",
        )
    result: dict[str, str] = {}
    for item in properties:
        if isinstance(item, dict) and item.get("name") is not None and item.get("value") is not None:
            result[_normalized_text(item["name"])] = _normalized_text(item["value"])
    return result


def _validate_identity(product: dict[str, Any]) -> tuple[str, dict[str, str]]:
    name = str(product.get("name") or "").strip()
    normalized_name = _normalized_text(name)
    if "t300" not in normalized_name or "380" not in normalized_name:
        raise PermanentCollectionError(
            f"Unexpected product name: {name or 'missing'}",
            code="product_mismatch",
        )

    specs = _product_specs(product)
    for spec_name, expected_value in EXPECTED_SPECS.items():
        actual_value = specs.get(spec_name)
        if actual_value is None:
            raise PermanentCollectionError(
                f"Required product specification is missing: {spec_name}",
                code="missing_product_specification",
            )
        if actual_value != _normalized_text(expected_value):
            raise PermanentCollectionError(
                f"Unexpected product specification: {spec_name}",
                code="product_mismatch",
            )
    return name, specs


def _single_offer(product: dict[str, Any]) -> dict[str, Any]:
    raw_offers = product.get("offers")
    offers = raw_offers if isinstance(raw_offers, list) else [raw_offers]
    valid_offers = [
        offer
        for offer in offers
        if isinstance(offer, dict) and offer.get("price") is not None
    ]
    if not valid_offers:
        raise PermanentCollectionError("Published price is missing", code="missing_price")
    if len(valid_offers) > 1:
        raise PermanentCollectionError("Published price is ambiguous", code="ambiguous_price")
    return valid_offers[0]


def parse_centr_to_t300(html: str) -> CentrToProduct:
    parser = _JsonLdParser()
    parser.feed(html)
    products: list[dict[str, Any]] = []
    invalid_blocks = 0
    for block in parser.blocks:
        try:
            products.extend(_walk_products(json.loads(block)))
        except json.JSONDecodeError:
            invalid_blocks += 1

    candidates = [
        product
        for product in products
        if "t300" in _normalized_text(product.get("name") or "")
    ]
    matching: list[tuple[dict[str, Any], str, dict[str, str]]] = []
    identity_errors: list[PermanentCollectionError] = []
    for product in candidates:
        try:
            name, specs = _validate_identity(product)
            matching.append((product, name, specs))
        except PermanentCollectionError as error:
            identity_errors.append(error)
    if not matching:
        if identity_errors:
            raise identity_errors[0]
        code = "invalid_structured_data" if invalid_blocks and not products else "product_mismatch"
        raise PermanentCollectionError("Exact T300/380 product data was not found", code=code)
    if len(matching) > 1:
        raise PermanentCollectionError("Exact T300/380 product data is ambiguous", code="ambiguous_product")

    product, name, specs = matching[0]
    offer = _single_offer(product)
    currency = str(offer.get("priceCurrency") or "").upper()
    if currency != "RUB":
        raise PermanentCollectionError(
            f"Unsupported currency: {currency or 'missing'}",
            code="unsupported_currency",
        )
    try:
        price = parse_money(str(offer["price"]))
    except ValueError as error:
        raise PermanentCollectionError(
            "Published price has an unsupported format",
            code="invalid_price",
        ) from error
    availability = str(offer["availability"]) if offer.get("availability") else None
    return CentrToProduct(name, price, currency, availability, specs)


def _stock_status(availability: str | None) -> str | None:
    if availability is None:
        return None
    value = availability.rstrip("/").rsplit("/", 1)[-1].casefold()
    return {
        "instock": "in_stock",
        "outofstock": "out_of_stock",
        "preorder": "preorder",
        "backorder": "backorder",
    }.get(value)


class CentrToT300Adapter:
    key = SOURCE_KEY
    method = "http"

    def __init__(
        self,
        fetcher: PageFetcher,
        *,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._fetcher = fetcher
        self._clock = clock or (lambda: datetime.now(UTC))

    def collect(self, task: SourceTask) -> CollectedObservation:
        url = urlsplit(task.url)
        hostname = (url.hostname or "").casefold().removeprefix("www.")
        if hostname != "centr-to.ru" or not re.match(
            rf"^/good-{EXPECTED_PRODUCT_ID}(?:-|$)",
            url.path,
        ):
            raise PermanentCollectionError(
                "The centr-to adapter only supports the verified T300/380 card",
                code="unsupported_offer",
            )
        response = self._fetcher.fetch(
            task.url,
            timeout=task.timeout_seconds,
            rate_limit_per_host=task.rate_limit_per_host,
        )
        try:
            product = parse_centr_to_t300(response.text)
        except PermanentCollectionError:
            PlaywrightFetcher.assert_not_protected(response.text)
            raise

        stock_status = _stock_status(product.availability)
        decision = evaluate_price(
            PriceInput(
                raw_price=product.price,
                price_type=PriceType.RETAIL,
                package_quantity=Decimal("1"),
                currency=product.currency,
                stock_status=stock_status,
            ),
            MatchStatus.EXACT,
        )
        evidence = {
            "product_name": product.name,
            "seller_article": EXPECTED_PRODUCT_ID,
            "price": str(product.price),
            "currency": product.currency,
            "availability": product.availability,
            "specifications": product.specifications,
            "source_url": task.url,
            "structured_data": "schema.org JSON-LD",
        }
        return CollectedObservation(
            price=decision,
            source_quantity=Decimal("1"),
            normalized_quantity=Decimal("1"),
            unit="piece",
            observed_at=self._clock(),
            evidence_text=(
                f"{EXPECTED_PRODUCT_ID}; {product.price} {product.currency}; "
                f"{stock_status or 'stock unknown'}"
            ),
            evidence=evidence,
            source_payload_hash=sha256(response.text.encode("utf-8")).hexdigest(),
        )
