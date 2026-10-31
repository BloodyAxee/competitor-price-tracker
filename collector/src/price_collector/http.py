import time
from dataclasses import dataclass
from threading import Lock
from typing import Callable, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from .errors import ManualFallbackRequired, PermanentCollectionError, RetryableCollectionError


@dataclass(frozen=True)
class HttpResponse:
    status_code: int
    text: str
    headers: Mapping[str, str]


class HttpTransport(Protocol):
    def request(self, url: str, headers: Mapping[str, str], timeout: float) -> HttpResponse: ...


class UrllibTransport:
    def request(self, url: str, headers: Mapping[str, str], timeout: float) -> HttpResponse:
        request = Request(url, headers=dict(headers), method="GET")
        try:
            with urlopen(request, timeout=timeout) as response:
                body = response.read().decode(response.headers.get_content_charset() or "utf-8", errors="replace")
                return HttpResponse(response.status, body, dict(response.headers.items()))
        except HTTPError as error:
            body = error.read().decode(error.headers.get_content_charset() or "utf-8", errors="replace")
            return HttpResponse(error.code, body, dict(error.headers.items()))
        except (TimeoutError, URLError) as error:
            raise RetryableCollectionError(str(error), code="network_error") from error


class HostRateLimiter:
    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        self._clock = clock
        self._sleeper = sleeper
        self._last_request: dict[str, float] = {}
        self._lock = Lock()

    def wait(self, url: str, requests_per_second: float) -> None:
        if requests_per_second <= 0:
            raise ValueError("requests_per_second must be positive")
        host = urlparse(url).netloc.casefold()
        minimum_interval = 1 / requests_per_second

        with self._lock:
            now = self._clock()
            previous = self._last_request.get(host)
            if previous is not None:
                remaining = minimum_interval - (now - previous)
                if remaining > 0:
                    self._sleeper(remaining)
                    now = self._clock()
            self._last_request[host] = now


class HttpFetcher:
    def __init__(
        self,
        user_agent: str,
        *,
        transport: HttpTransport | None = None,
        limiter: HostRateLimiter | None = None,
    ) -> None:
        if not user_agent.strip():
            raise ValueError("An identifiable User-Agent is required")
        self._user_agent = user_agent
        self._transport = transport or UrllibTransport()
        self._limiter = limiter or HostRateLimiter()

    def fetch(self, url: str, *, timeout: float, rate_limit_per_host: float) -> HttpResponse:
        self._limiter.wait(url, rate_limit_per_host)
        response = self._transport.request(
            url,
            {"User-Agent": self._user_agent, "Accept": "text/html,application/xhtml+xml"},
            timeout,
        )

        if response.status_code == 429 or response.status_code >= 500:
            raise RetryableCollectionError(
                f"Temporary HTTP status {response.status_code}",
                code="temporary_http_error",
                http_status=response.status_code,
            )
        if response.status_code in (401, 403):
            raise ManualFallbackRequired(
                f"Protected source returned HTTP {response.status_code}",
                code="protected_source",
                http_status=response.status_code,
            )
        if response.status_code >= 400:
            raise PermanentCollectionError(
                f"HTTP status {response.status_code}",
                code="http_error",
                http_status=response.status_code,
            )
        return response
