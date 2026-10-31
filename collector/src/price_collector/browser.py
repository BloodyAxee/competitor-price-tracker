from dataclasses import dataclass

from .errors import ManualFallbackRequired, PermanentCollectionError, RetryableCollectionError


@dataclass(frozen=True)
class BrowserDocument:
    url: str
    html: str
    status_code: int | None


class PlaywrightFetcher:
    _PROTECTION_MARKERS = (
        "captcha",
        "recaptcha",
        "verify you are human",
        "cloudflare challenge",
    )

    def __init__(self, user_agent: str) -> None:
        if not user_agent.strip():
            raise ValueError("An identifiable User-Agent is required")
        self._user_agent = user_agent

    @classmethod
    def assert_not_protected(cls, html: str) -> None:
        lowered = html.casefold()
        if any(marker in lowered for marker in cls._PROTECTION_MARKERS):
            raise ManualFallbackRequired(
                "The page requires a human verification step",
                code="human_verification_required",
            )

    def fetch(self, url: str, *, timeout: float) -> BrowserDocument:
        from playwright.sync_api import Error as PlaywrightError
        from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
        from playwright.sync_api import sync_playwright

        try:
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(headless=True)
                try:
                    page = browser.new_page(user_agent=self._user_agent)
                    response = page.goto(url, wait_until="domcontentloaded", timeout=int(timeout * 1000))
                    html = page.content()
                    self.assert_not_protected(html)
                    status = response.status if response else None
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
                    return BrowserDocument(page.url, html, status)
                finally:
                    browser.close()
        except PlaywrightTimeoutError as error:
            raise RetryableCollectionError("Browser timeout", code="browser_timeout") from error
        except (ManualFallbackRequired, PermanentCollectionError, RetryableCollectionError):
            raise
        except PlaywrightError as error:
            raise RetryableCollectionError("Browser error", code="browser_error") from error
