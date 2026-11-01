from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread

from .browser import PlaywrightFetcher


class DynamicPageHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        body = b"""<!doctype html>
<html><body>
<div id="price">loading</div>
<script>
setTimeout(() => {
  document.getElementById("price").textContent = "123 456 RUB";
  document.body.dataset.rendered = "true";
}, 80);
</script>
</body></html>"""
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        return


def main() -> None:
    server = ThreadingHTTPServer(("127.0.0.1", 0), DynamicPageHandler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        url = f"http://127.0.0.1:{server.server_port}/dynamic-product"
        document = PlaywrightFetcher(
            "CompetitorPriceTracker/0.1 (playwright-smoke)",
            settle_ms=200,
        ).fetch(url, timeout=5, rate_limit_per_host=1000)
        if document.status_code != 200:
            raise RuntimeError(f"Unexpected browser status {document.status_code}")
        if 'data-rendered="true"' not in document.html or "123 456 RUB" not in document.html:
            raise RuntimeError("Chromium did not return the JavaScript-rendered product state")
        print("Playwright smoke passed: Chromium rendered dynamic product content")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
