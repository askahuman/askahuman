#!/usr/bin/env python3
"""Bounded public HTTPS release probes; fixed results, no response/header dumps."""
import json
import os
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

from production_preflight import COMMIT, VERSION, Report

ORIGIN = "https://ask-a-human.ai"


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def get(opener, path, extra_headers=None):
    headers = {"Cache-Control": "no-cache", "Accept": "application/json"}
    headers.update(extra_headers or {})
    with opener.open(Request(ORIGIN + path, headers=headers), timeout=15) as response:
        body = response.read(16385)
        if response.status != 200 or len(body) > 16384:
            raise ValueError("invalid response")
        if "no-store" not in [v.strip() for v in response.headers.get("Cache-Control", "").lower().split(",")]:
            raise ValueError("response is cacheable")
        return body, response.headers


def verify(report, version, commit, opener):
    def web():
        body, headers = get(opener, "/version.json")
        return (headers.get_content_type() == "application/json"
                and json.loads(body) == {"version": version, "commit": commit})

    def relay():
        body, headers = get(opener, "/healthz")
        return (body == b"ok" and headers.get("X-AAH-Version") == version
                and headers.get("X-AAH-Commit") == commit)

    def proxy(extra_headers=None):
        body, headers = get(opener, "/healthz/proxy", extra_headers)
        payload = json.loads(body)
        return (headers.get_content_type() == "application/json" and isinstance(payload, dict)
                and set(payload) == {"trusted_proxy", "valid_suffix"}
                and all(value is True for value in payload.values()))

    report.check("public_web_version", web)
    report.check("public_relay_version", relay)
    report.check("public_gfe_proxy_suffix", proxy)
    report.check("public_gfe_ignores_spoofed_prefix", lambda: proxy({
        "X-Forwarded-For": "198.51.100.123, malformed-client-prefix"}))


def main():
    report = Report()
    version, commit = os.environ.get("EXPECTED_VERSION", ""), os.environ.get("EXPECTED_COMMIT", "")
    if not report.check("public_release_inputs", lambda: VERSION.fullmatch(version) and COMMIT.fullmatch(commit)):
        return 1
    # Ignore proxy environment variables; do not send credentials or follow any
    # redirect to another destination. The origin and four paths are fixed.
    verify(report, version, commit, build_opener(ProxyHandler({}), NoRedirect()))
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
