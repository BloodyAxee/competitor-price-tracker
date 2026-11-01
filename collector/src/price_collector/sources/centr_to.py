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
T300_PRODUCT_ID = "15155"
T300_EXPECTED_SPECS = {
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
        return {}
    result: dict[str, str] = {}
    for item in properties:
        if isinstance(item, dict) and item.get("name") is not None and item.get("value") is not None:
            result[_normalized_text(item["name"])] = _normalized_text(item["value"])
    return result


def _identity_tokens(value: str) -> tuple[str, ...]:
    normalized = _normalized_text(value).replace("×", "x")
    raw_tokens = re.findall(r"[a-zа-яё0-9]+(?:[-./][a-zа-яё0-9]+)*", normalized)
    compact_tokens = [re.sub(r"[^a-zа-яё0-9]", "", token) for token in raw_tokens]
    model_tokens = [
        token
        for token in compact_tokens
        if len(token) >= 3
        and (
            (any(character.isalpha() for character in token) and any(character.isdigit() for character in token))
            or (token.isdigit() and len(token) >= 4)
        )
    ]
    if model_tokens:
        return tuple(dict.fromkeys(model_tokens))

    ignored = {
        "автомат",
        "балансировочный",
        "грузовых",
        "колес",
        "комплект",
        "окрасочная",
        "полуавтомат",
        "станок",
        "стенд",
        "сушильная",
        "шиномонтажный",
        "nordberg",
        "rossvik",
        "guangli",
    }
    distinctive = [token for token in compact_tokens if len(token) >= 4 and token not in ignored]
    return (max(distinctive, key=len),) if distinctive else ()


def _validate_identity(
    product: dict[str, Any],
    expected_name: str,
    required_specs: dict[str, str] | None = None,
) -> tuple[str, dict[str, str]]:
    name = str(product.get("name") or "").strip()
    actual_compact = re.sub(r"[^a-zа-яё0-9]", "", _normalized_text(name))
    expected_tokens = _identity_tokens(expected_name)
    if not expected_tokens:
        raise PermanentCollectionError(
            "The expected product name has no stable identity token",
            code="unsupported_offer",
        )
    if any(token not in actual_compact for token in expected_tokens):
        raise PermanentCollectionError(
            f"Unexpected product name: {name or 'missing'}",
            code="product_mismatch",
        )

    specs = _product_specs(product)
    for spec_name, expected_value in (required_specs or {}).items():
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


def parse_centr_to_product(
    html: str,
    expected_name: str,
    *,
    required_specs: dict[str, str] | None = None,
) -> CentrToProduct:
    parser = _JsonLdParser()
    parser.feed(html)
    products: list[dict[str, Any]] = []
    invalid_blocks = 0
    for block in parser.blocks:
        try:
            products.extend(_walk_products(json.loads(block)))
        except json.JSONDecodeError:
            invalid_blocks += 1

    matching: list[tuple[dict[str, Any], str, dict[str, str]]] = []
    identity_errors: list[PermanentCollectionError] = []
    for product in products:
        try:
            name, specs = _validate_identity(product, expected_name, required_specs)
            matching.append((product, name, specs))
        except PermanentCollectionError as error:
            identity_errors.append(error)
    if not matching:
        if identity_errors:
            raise identity_errors[0]
        code = "invalid_structured_data" if invalid_blocks and not products else "product_mismatch"
        raise PermanentCollectionError("Exact product data was not found", code=code)
    if len(matching) > 1:
        raise PermanentCollectionError("Exact product data is ambiguous", code="ambiguous_product")

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


def parse_centr_to_t300(html: str) -> CentrToProduct:
    return parse_centr_to_product(
        html,
        "Шиномонтажный станок Станкоимпорт T300, 380 В",
        required_specs=T300_EXPECTED_SPECS,
    )


class CentrToAdapter:
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
        path_match = re.match(r"^/good-(\d+)(?:-|$)", url.path)
        if hostname != "centr-to.ru" or path_match is None:
            raise PermanentCollectionError(
                "The centr-to adapter only supports product card URLs",
                code="unsupported_offer",
            )
        product_id = path_match.group(1)
        if task.seller_article and task.seller_article != product_id:
            raise PermanentCollectionError(
                "The product card ID does not match the imported offer",
                code="product_mismatch",
            )
        if not task.expected_product_name:
            raise PermanentCollectionError(
                "The imported offer has no expected product name",
                code="unsupported_offer",
            )
        response = self._fetcher.fetch(
            task.url,
            timeout=task.timeout_seconds,
            rate_limit_per_host=task.rate_limit_per_host,
        )
        try:
            required_specs = T300_EXPECTED_SPECS if product_id == T300_PRODUCT_ID else None
            product = parse_centr_to_product(
                response.text,
                task.expected_product_name,
                required_specs=required_specs,
            )
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
            "expected_product_name": task.expected_product_name,
            "identity_tokens": _identity_tokens(task.expected_product_name),
            "seller_article": product_id,
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
                f"{product_id}; {product.price} {product.currency}; "
                f"{stock_status or 'stock unknown'}"
            ),
            evidence=evidence,
            source_payload_hash=sha256(response.text.encode("utf-8")).hexdigest(),
        )


CentrToT300Adapter = CentrToAdapter
