from collections.abc import Callable
from dataclasses import dataclass
from typing import Generic, Protocol, TypeVar

from ..browser import BrowserDocument, PlaywrightFetcher
from ..errors import PermanentCollectionError, RetryableCollectionError
from ..http import HttpResponse
from ..models import SourceTask


ProductT = TypeVar("ProductT")


class HttpPageFetcher(Protocol):
    def fetch(self, url: str, *, timeout: float, rate_limit_per_host: float) -> HttpResponse: ...


class BrowserPageFetcher(Protocol):
    def fetch(
        self,
        url: str,
        *,
        timeout: float,
        rate_limit_per_host: float,
    ) -> BrowserDocument: ...


@dataclass(frozen=True)
class ProductParser(Generic[ProductT]):
    name: str
    parse: Callable[[str], ProductT]


@dataclass(frozen=True)
class ProductExtraction(Generic[ProductT]):
    product: ProductT
    html: str
    parser: str
    transport: str
    final_url: str


def _parse_document(
    html: str,
    parsers: tuple[ProductParser[ProductT], ...],
) -> tuple[ProductT, str]:
    errors: list[PermanentCollectionError] = []
    for parser in parsers:
        try:
            return parser.parse(html), parser.name
        except PermanentCollectionError as error:
            errors.append(error)

    if len(errors) == 1:
        raise errors[0]
    details = "; ".join(f"{parser.name}: {error}" for parser, error in zip(parsers, errors, strict=True))
    raise PermanentCollectionError(
        f"All product extractors failed: {details}"[:1000],
        code="all_extractors_failed",
    )


def extract_product(
    task: SourceTask,
    http_fetcher: HttpPageFetcher,
    parsers: tuple[ProductParser[ProductT], ...],
    *,
    browser_fetcher: BrowserPageFetcher | None = None,
) -> ProductExtraction[ProductT]:
    try:
        response = http_fetcher.fetch(
            task.url,
            timeout=task.timeout_seconds,
            rate_limit_per_host=task.rate_limit_per_host,
        )
    except RetryableCollectionError as error:
        if browser_fetcher is None or error.code != "network_error":
            raise
        document = browser_fetcher.fetch(
            task.url,
            timeout=task.timeout_seconds,
            rate_limit_per_host=task.rate_limit_per_host,
        )
        PlaywrightFetcher.assert_not_protected(document.html)
        product, parser = _parse_document(document.html, parsers)
        return ProductExtraction(product, document.html, parser, "browser", document.url)
    PlaywrightFetcher.assert_not_protected(response.text)
    try:
        product, parser = _parse_document(response.text, parsers)
        return ProductExtraction(product, response.text, parser, "http", task.url)
    except PermanentCollectionError:
        if browser_fetcher is None:
            raise

    document = browser_fetcher.fetch(
        task.url,
        timeout=task.timeout_seconds,
        rate_limit_per_host=task.rate_limit_per_host,
    )
    PlaywrightFetcher.assert_not_protected(document.html)
    product, parser = _parse_document(document.html, parsers)
    return ProductExtraction(product, document.html, parser, "browser", document.url)
