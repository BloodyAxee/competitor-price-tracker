import re
from collections import defaultdict
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from hashlib import sha256
from html.parser import HTMLParser

from price_monitor_domain import MatchStatus, PriceInput, PriceType, evaluate_price, parse_money

from ..errors import PermanentCollectionError
from ..models import CollectedObservation, SourceTask
from .fallback import BrowserPageFetcher, HttpPageFetcher, ProductParser, extract_product


EXPECTED_SKU = "T300 380V"
SOURCE_KEY = "source:si-tools.ru"
_VOID_ELEMENTS = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}


@dataclass(frozen=True)
class SiToolsProduct:
    name: str
    sku: str
    price: Decimal
    currency: str
    availability: str | None


@dataclass
class _Capture:
    field: str
    depth: int
    text: list[str]


class _ProductMicrodataParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.values: defaultdict[str, list[str]] = defaultdict(list)
        self._captures: list[_Capture] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        attributes = {key.casefold(): value for key, value in attrs}
        is_void = tag in _VOID_ELEMENTS
        if not is_void:
            for capture in self._captures:
                capture.depth += 1

        itemprops = set((attributes.get("itemprop") or "").casefold().split())
        field = self._field_for(tag, itemprops)
        if field is None:
            return

        immediate = attributes.get("content")
        if field == "availability":
            immediate = attributes.get("href") or immediate
        if immediate:
            self._store(field, immediate)
        elif not is_void:
            self._captures.append(_Capture(field, 1, []))

    def handle_data(self, data: str) -> None:
        for capture in self._captures:
            capture.text.append(data)

    def handle_endtag(self, tag: str) -> None:
        finished: list[_Capture] = []
        for capture in self._captures:
            capture.depth -= 1
            if capture.depth == 0:
                finished.append(capture)
        for capture in finished:
            self._store(capture.field, "".join(capture.text))
            self._captures.remove(capture)

    @staticmethod
    def _field_for(tag: str, itemprops: set[str]) -> str | None:
        if tag == "h1" and "name" in itemprops:
            return "name"
        for field in ("sku", "price", "pricecurrency", "availability"):
            if field in itemprops:
                return field
        return None

    def _store(self, field: str, value: str) -> None:
        normalized = " ".join(value.split())
        if normalized:
            self.values[field].append(normalized)


def _single_value(values: list[str], field: str) -> str:
    unique = list(dict.fromkeys(values))
    if not unique:
        raise PermanentCollectionError(
            f"Required product field is missing: {field}",
            code=f"missing_{field}",
        )
    if len(unique) > 1:
        raise PermanentCollectionError(
            f"Product field is ambiguous: {field}",
            code=f"ambiguous_{field}",
        )
    return unique[0]


def _normalized_sku(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.casefold())


def parse_si_tools_t300(html: str) -> SiToolsProduct:
    parser = _ProductMicrodataParser()
    parser.feed(html)

    name = _single_value(parser.values["name"], "name")
    sku = _single_value(parser.values["sku"], "sku")
    price_text = _single_value(parser.values["price"], "price")
    currency = _single_value(parser.values["pricecurrency"], "currency").upper()

    if _normalized_sku(sku) != _normalized_sku(EXPECTED_SKU):
        raise PermanentCollectionError(
            f"Expected SKU {EXPECTED_SKU}, got {sku}",
            code="product_mismatch",
        )
    normalized_name = name.casefold()
    if "t300" not in normalized_name or "380" not in normalized_name:
        raise PermanentCollectionError(
            f"Unexpected product name: {name}",
            code="product_mismatch",
        )
    if currency != "RUB":
        raise PermanentCollectionError(
            f"Unsupported currency: {currency}",
            code="unsupported_currency",
        )

    try:
        price = parse_money(price_text)
    except ValueError as error:
        raise PermanentCollectionError(
            "Published price has an unsupported format",
            code="invalid_price",
        ) from error

    availability_values = list(dict.fromkeys(parser.values["availability"]))
    if len(availability_values) > 1:
        raise PermanentCollectionError(
            "Product availability is ambiguous",
            code="ambiguous_availability",
        )
    availability = availability_values[0] if availability_values else None
    return SiToolsProduct(name, sku, price, currency, availability)


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


class SiToolsT300Adapter:
    key = SOURCE_KEY
    method = "http"

    def __init__(
        self,
        fetcher: HttpPageFetcher,
        *,
        browser_fetcher: BrowserPageFetcher | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        self._fetcher = fetcher
        self._browser_fetcher = browser_fetcher
        self._clock = clock or (lambda: datetime.now(UTC))

    def collect(self, task: SourceTask) -> CollectedObservation:
        extraction = extract_product(
            task,
            self._fetcher,
            (ProductParser("schema.org microdata", parse_si_tools_t300),),
            browser_fetcher=self._browser_fetcher,
        )
        product = extraction.product
        stock_status = _stock_status(product.availability)
        decision = evaluate_price(
            PriceInput(
                raw_price=product.price,
                price_type=PriceType.RETAIL,
                package_quantity=Decimal("1"),
                currency=product.currency,
                stock_status=stock_status,
            ),
            MatchStatus(task.match_status),
        )
        evidence = {
            "product_name": product.name,
            "sku": product.sku,
            "price": str(product.price),
            "currency": product.currency,
            "availability": product.availability,
            "source_url": extraction.final_url,
            "structured_data": extraction.parser,
            "transport": extraction.transport,
        }
        return CollectedObservation(
            price=decision,
            source_quantity=Decimal("1"),
            normalized_quantity=Decimal("1"),
            unit="piece",
            observed_at=self._clock(),
            evidence_text=f"{product.sku}; {product.price} {product.currency}; {stock_status or 'stock unknown'}",
            evidence=evidence,
            source_payload_hash=sha256(extraction.html.encode("utf-8")).hexdigest(),
        )
