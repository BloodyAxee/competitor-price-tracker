from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from time import sleep
from urllib.parse import urlsplit

from .errors import ManualFallbackRequired, PermanentCollectionError, RetryableCollectionError
from .http import HostRateLimiter


@dataclass(frozen=True)
class BrowserDocument:
    url: str
    html: str
    status_code: int | None


class PlaywrightFetcher:
    _PROTECTION_MARKERS = (
        "verify you are human",
        "confirm you are human",
        "checking your browser",
        "attention required! | cloudflare",
        "cloudflare challenge",
        "подтвердите, что вы человек",
        "проверка, что вы человек",
        "user verification",
    )

    def __init__(
        self,
        user_agent: str,
        *,
        limiter: HostRateLimiter | None = None,
        settle_ms: int = 300,
        storage_state_path: str | None = None,
        verification_retry_hosts: tuple[str, ...] = (),
        verification_retry_seconds: float = 3,
        sleeper: Callable[[float], None] = sleep,
    ) -> None:
        if not user_agent.strip():
            raise ValueError("An identifiable User-Agent is required")
        if settle_ms < 0:
            raise ValueError("settle_ms must not be negative")
        if verification_retry_seconds < 0:
            raise ValueError("verification_retry_seconds must not be negative")
        self._user_agent = user_agent
        self._limiter = limiter or HostRateLimiter()
        self._settle_ms = settle_ms
        self._storage_state_path = Path(storage_state_path) if storage_state_path else None
        self._verification_retry_hosts = {
            host.strip().casefold().removeprefix("www.")
            for host in verification_retry_hosts
            if host.strip()
        }
        self._verification_retry_seconds = verification_retry_seconds
        self._sleeper = sleeper
        self._state_lock = Lock()

    @classmethod
    def is_protected(cls, html: str) -> bool:
        lowered = html.casefold()
        return any(marker in lowered for marker in cls._PROTECTION_MARKERS)

    @classmethod
    def assert_not_protected(cls, html: str) -> None:
        if cls.is_protected(html):
            raise ManualFallbackRequired(
                "The page requires a human verification step",
                code="human_verification_required",
            )

    def _can_retry_verification(self, url: str) -> bool:
        hostname = (urlsplit(url).hostname or "").casefold().removeprefix("www.")
        return any(
            hostname == host or hostname.endswith(f".{host}")
            for host in self._verification_retry_hosts
        )

    @classmethod
    def _validate_document(cls, document: BrowserDocument) -> None:
        cls.assert_not_protected(document.html)
        status = document.status_code
        if status in (401, 403):
            raise ManualFallbackRequired(
                f"Protected source returned HTTP {status}",
                code="protected_source",
                http_status=status,
            )
        if status == 429 or (status is not None and status >= 500):
            raise RetryableCollectionError(
                f"Temporary HTTP status {status}",
                code="temporary_http_error",
                http_status=status,
            )
        if status is not None and status >= 400:
            raise PermanentCollectionError(
                f"HTTP status {status}",
                code="http_error",
                http_status=status,
            )

    def fetch(
        self,
        url: str,
        *,
        timeout: float,
        rate_limit_per_host: float,
    ) -> BrowserDocument:
        lock = self._state_lock if self._storage_state_path else Lock()
        with lock:
            self._limiter.wait(url, rate_limit_per_host)
            document = self._fetch_document(url, timeout=timeout)
            requires_verification = (
                self.is_protected(document.html) or document.status_code in (401, 403)
            )
            if requires_verification and self._can_retry_verification(url):
                if self._verification_retry_seconds:
                    self._sleeper(self._verification_retry_seconds)
                self._limiter.wait(url, rate_limit_per_host)
                document = self._fetch_document(url, timeout=timeout)
            self._validate_document(document)
            return document

    def _fetch_document(self, url: str, *, timeout: float) -> BrowserDocument:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    context_options: dict[str, object] = {
                        "user_agent": self._user_agent,
                        "locale": "ru-RU",
                        "timezone_id": "Europe/Moscow",
                        "viewport": {"width": 1365, "height": 900},
                    }
                    if (
                        self._storage_state_path is not None
                        and self._storage_state_path.is_file()
                    ):
                        context_options["storage_state"] = str(self._storage_state_path)
                    context = browser.new_context(**context_options)
                    try:
                        page = context.new_page()
                        response = page.goto(
                            url,
                            wait_until="domcontentloaded",
                            timeout=int(timeout * 1000),
                        )
                        settle_ms = min(self._settle_ms, max(0, int(timeout * 250)))
                        if settle_ms:
                            page.wait_for_timeout(settle_ms)
                        html = page.content()
                        if self._storage_state_path:
                            self._storage_state_path.parent.mkdir(
                                parents=True,
                                exist_ok=True,
                            )
                            context.storage_state(path=str(self._storage_state_path))
                        return BrowserDocument(
                            page.url,
                            html,
                            response.status if response else None,
                        )
                    finally:
                        context.close()
                finally:
                    browser.close()
        except PlaywrightTimeoutError as error:
            raise RetryableCollectionError("Browser timeout", code="browser_timeout") from error
        except (ManualFallbackRequired, PermanentCollectionError, RetryableCollectionError):
            raise
        except PlaywrightError as error:
            raise RetryableCollectionError("Browser error", code="browser_error") from error
