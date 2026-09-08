"""Smoke-check the real nginx container started by CI; no external services."""
import json
import os
import re
from urllib.request import urlopen


def get(path):
    with urlopen("http://127.0.0.1:18081" + path, timeout=10) as response:
        assert response.status == 200, path
        headers = response.headers
        assert headers["X-Content-Type-Options"] == "nosniff", path
        assert headers["X-Frame-Options"] == "DENY", path
        assert "frame-ancestors 'none'" in headers["Content-Security-Policy"], path
        return response.read().decode(), headers


html, headers = get("/app/")
assert "text/html" in headers["Content-Type"]
assert "no-cache" in headers["Cache-Control"]
assert 'http-equiv="content-security-policy"' in html.lower()
asset = re.search(r'(?:src|component-url)="(/_astro/[^"\s]+\.js)"', html)
assert asset, "built app must reference a fingerprinted JavaScript asset"
_, headers = get(asset[1])
assert "immutable" in headers["Cache-Control"]
worker, headers = get("/sw.js")
assert "javascript" in headers["Content-Type"] and worker
assert "no-store" in headers["Cache-Control"]
manifest, _ = get("/manifest.webmanifest")
assert json.loads(manifest)["start_url"].rstrip("/") == "/app"
version, headers = get("/version.json")
assert "application/json" in headers["Content-Type"]
assert "no-store" in headers["Cache-Control"]
assert json.loads(version) == {
    "version": os.environ.get("EXPECTED_VERSION", "dev"),
    "commit": os.environ.get("EXPECTED_COMMIT", "unknown"),
}
assert "version.json" not in worker, "release metadata must not enter the service-worker cache"
print("Production container serves app, JavaScript, worker, manifest and uncached version with security/cache headers.")
