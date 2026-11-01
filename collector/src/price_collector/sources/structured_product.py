from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from hashlib import sha256
from urllib.parse import urlsplit

from price_monitor_domain import MatchStatus, PriceInput, PriceType, evaluate_price

from ..errors import PermanentCollectionError
from ..models import CollectedObservation, SourceTask
from .fallback import BrowserPageFetcher, HttpPageFetcher, ProductParser, extract_product
from .structured_data import identity_tokens, parse_json_ld_product, parse_microdata_product, stock_status
from .visible_product import (
    VISIBLE_SOURCE_PROFILES,
    parse_visible_product,
    validate_visible_product_qualifiers,
)


STRUCTURED_SOURCE_KEYS = (
    "source:aet-auto.ru",
    "source:autoservice2.ru",
    "source:carmod.ru",
    "source:master-instrument.ru",
    "source:nordberg-shop.ru",
    "source:nordberg.ru",
    "source:optima-trade.ru",
    "source:rossvik.moscow",
    "source:rustehnika.ru",
    "source:technovector.ru",
    "source:topmaster-shop.ru",
    "source:tmktools.ru",
)


class StructuredProductAdapter:
    method = "http"

    def __init__(
        self,
        fetcher: HttpPageFetcher,
        source_key: str,
        *,
        browser_fetcher: BrowserPageFetcher | None = None,
        clock: Callable[[], datetime] | None = None,
    ) -> None:
        if source_key not in STRUCTURED_SOURCE_KEYS:
            raise ValueError(f"Unsupported structured source: {source_key}")
        self.key = source_key
        self._expected_domain = source_key.removeprefix("source:")
        self._fetcher = fetcher
        self._browser_fetcher = browser_fetcher
        self._clock = clock or (lambda: datetime.now(UTC))

    def collect(self, task: SourceTask) -> CollectedObservation:
        hostname = (urlsplit(task.url).hostname or "").casefold().removeprefix("www.")
        if hostname != self._expected_domain and not hostname.endswith(f".{self._expected_domain}"):
            raise PermanentCollectionError(
                "The task URL does not belong to the configured source",
                code="source_mismatch",
            )
        if not task.expected_product_name:
            raise PermanentCollectionError(
                "The imported offer has no expected product name",
                code="unsupported_offer",
            )

        parsers = [
            ProductParser(
                "schema.org JSON-LD",
                lambda html: parse_json_ld_product(html, task.expected_product_name or ""),
            ),
            ProductParser(
                "schema.org microdata",
                lambda html: parse_microdata_product(html, task.expected_product_name or ""),
            ),
        ]
        visible_profile = VISIBLE_SOURCE_PROFILES.get(self.key)
        if visible_profile is not None:
            parsers.append(
                ProductParser(
                    "visible product card",
                    lambda html: parse_visible_product(
                        html,
                        task.expected_product_name or "",
                        visible_profile,
                    ),
                )
            )
        extraction = extract_product(
            task,
            self._fetcher,
            tuple(parsers),
            browser_fetcher=self._browser_fetcher,
        )
        if visible_profile is not None:
            validate_visible_product_qualifiers(
                extraction.html,
                task.expected_product_name or "",
                visible_profile,
            )
        product = extraction.product

        current_stock = stock_status(product.availability)
        decision = evaluate_price(
            PriceInput(
                raw_price=product.price,
                price_type=PriceType.RETAIL,
                package_quantity=Decimal("1"),
                currency=product.currency,
                stock_status=current_stock,
            ),
            MatchStatus.EXACT,
        )
        return CollectedObservation(
            price=decision,
            source_quantity=Decimal("1"),
            normalized_quantity=Decimal("1"),
            unit="piece",
            observed_at=self._clock(),
            evidence_text=(
                f"{product.name}; {product.price} {product.currency}; "
                f"{current_stock or 'stock unknown'}"
            ),
            evidence={
                "product_name": product.name,
                "expected_product_name": task.expected_product_name,
                "identity_tokens": identity_tokens(task.expected_product_name),
                "price": str(product.price),
                "currency": product.currency,
                "availability": product.availability,
                "source_url": extraction.final_url,
                "structured_data": extraction.parser,
                "transport": extraction.transport,
            },
            source_payload_hash=sha256(extraction.html.encode("utf-8")).hexdigest(),
        )
