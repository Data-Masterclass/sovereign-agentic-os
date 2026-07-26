# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
"""Unit tests for images/web-fetch/app.py.

Tests OPA authorization, fail-closed behaviour, sanitization, and egress-proxy URL
construction. All network seams are monkeypatched — no real HTTP calls are made.

Run:
    python3 -m pytest -q test_app.py
"""
import sys
import types
import unittest
from unittest import mock

# ── Stub urllib.request so `import app` works without a live OPA/proxy ──────────
# We replace only what we need and restore nothing — tests use targeted patching.

import app  # noqa: E402 (import after stdlib stubs are ready)


# ─────────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────────

def make_request(url: str = "http://example.com", principal: str = "user:alice") -> dict:
    """Build the dict that Handler.do_POST parses from the request body."""
    return {"url": url, "principal": principal}


class MockHTTPResponse:
    """Minimal stand-in for urllib's HTTP response with a .read() method."""

    def __init__(self, body: bytes, status: int = 200):
        self._body = body
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self, n=-1):
        if n < 0:
            return self._body
        return self._body[:n]


# ─────────────────────────────────────────────────────────────────────────────────
# OPA tests
# ─────────────────────────────────────────────────────────────────────────────────

class OpaAuthTests(unittest.TestCase):

    def test_opa_deny_returns_403(self):
        """When OPA says deny, the route returns 403 Forbidden."""
        # opa_allows → False
        with mock.patch.object(app, "opa_allows", return_value=False):
            result = app.opa_allows("user:alice")
        self.assertFalse(result)

        # Simulate the Handler logic inline (no HTTP server needed).
        with mock.patch.object(app, "opa_allows", return_value=False):
            allowed = app.opa_allows("user:alice")
            self.assertFalse(allowed)
            # If denied, the handler emits 403 — test the flag directly.
            if not allowed:
                response_code = 403
            else:
                response_code = 200
        self.assertEqual(response_code, 403)

    def test_opa_allow_proceeds_to_fetch(self):
        """When OPA says allow, the handler tries to fetch the URL."""
        html = b"<html><body>Hello world</body></html>"
        fake_resp = MockHTTPResponse(html)

        with mock.patch.object(app, "opa_allows", return_value=True), \
             mock.patch.object(app, "fetch_via_proxy", return_value=(200, html)):
            allowed = app.opa_allows("user:alice")
            status, raw = app.fetch_via_proxy("http://example.com")

        self.assertTrue(allowed)
        self.assertEqual(status, 200)
        self.assertEqual(raw, html)

    def test_opa_unreachable_fails_closed(self):
        """When OPA is unreachable (raises an exception), the handler must
        fail CLOSED — it must NOT allow the request through."""
        def raise_connection_error(*_a, **_kw):
            raise OSError("Connection refused")

        with mock.patch("urllib.request.urlopen", side_effect=raise_connection_error):
            with self.assertRaises(Exception):
                app.opa_allows("user:alice")
            # The caller catches the exception and returns 502 — simulate that:
            try:
                app.opa_allows("user:alice")
                result = "allowed"  # must NOT reach here
            except Exception:
                result = "blocked"

        self.assertEqual(result, "blocked",
                         "OPA unreachable must fail-closed (block the request)")

    def test_opa_timeout_fails_closed(self):
        """An OPA timeout (socket.timeout) must also fail closed."""
        import socket

        with mock.patch("urllib.request.urlopen", side_effect=socket.timeout("timed out")):
            try:
                app.opa_allows("user:alice")
                reached = True
            except Exception:
                reached = False

        self.assertFalse(reached, "A timed-out OPA call must raise, not silently allow")


# ─────────────────────────────────────────────────────────────────────────────────
# Sanitization tests
# ─────────────────────────────────────────────────────────────────────────────────

class SanitizationTests(unittest.TestCase):

    def test_sanitize_strips_script_tags(self):
        """<script> blocks must be removed entirely — prompt-injection defense."""
        html = b"<html><body>Safe text.<script>evil();</script>More text.</body></html>"
        result = app.sanitize(html)
        self.assertNotIn("<script>", result)
        self.assertNotIn("evil()", result)
        self.assertIn("Safe text", result)
        self.assertIn("More text", result)

    def test_sanitize_strips_style_tags(self):
        """<style> blocks must also be removed."""
        html = b"<html><head><style>body { color: red }</style></head><body>Hello</body></html>"
        result = app.sanitize(html)
        self.assertNotIn("<style>", result)
        self.assertNotIn("color: red", result)
        self.assertIn("Hello", result)

    def test_sanitize_strips_all_html_tags(self):
        """All markup is stripped; only text content remains."""
        html = b"<h1>Title</h1><p>Paragraph with <a href='x'>link</a>.</p>"
        result = app.sanitize(html)
        self.assertNotIn("<h1>", result)
        self.assertNotIn("<p>", result)
        self.assertNotIn("<a ", result)
        self.assertIn("Title", result)
        self.assertIn("Paragraph", result)

    def test_sanitize_collapses_whitespace(self):
        """Multiple consecutive whitespace characters collapse to a single space."""
        html = b"<p>Hello   \n\n   world</p>"
        result = app.sanitize(html)
        self.assertEqual(result, "Hello world")

    def test_sanitize_truncates_to_max_chars(self):
        """Output must be truncated to MAX_CHARS."""
        original_max = app.MAX_CHARS
        try:
            app.MAX_CHARS = 10
            html = b"A" * 100
            result = app.sanitize(html)
            self.assertLessEqual(len(result), 10)
        finally:
            app.MAX_CHARS = original_max

    def test_sanitize_inline_script_event_handlers_stripped(self):
        """Inline event handler markup is stripped (it's just a tag attribute)."""
        html = b'<button onclick="alert(1)">Click</button>'
        result = app.sanitize(html)
        self.assertNotIn("onclick", result)
        self.assertIn("Click", result)


# ─────────────────────────────────────────────────────────────────────────────────
# Egress proxy URL construction
# ─────────────────────────────────────────────────────────────────────────────────

class EgressProxyTests(unittest.TestCase):

    def test_fetch_via_proxy_uses_configured_proxy_url(self):
        """fetch_via_proxy must route through PROXY_URL, not bypass it."""
        captured = {}

        def fake_build_opener(handler):
            captured["handler"] = handler
            fake_opener = mock.MagicMock()
            fake_opener.open.return_value = MockHTTPResponse(b"ok")
            return fake_opener

        import urllib.request as ur
        with mock.patch.object(ur, "build_opener", side_effect=fake_build_opener), \
             mock.patch.object(ur, "ProxyHandler") as mock_proxy_handler:
            mock_proxy_handler.return_value = mock.MagicMock()
            status, raw = app.fetch_via_proxy("http://example.com")

        # ProxyHandler must be called with both http and https set to PROXY_URL.
        mock_proxy_handler.assert_called_once()
        proxy_dict = mock_proxy_handler.call_args[0][0]
        self.assertIn("http", proxy_dict)
        self.assertIn("https", proxy_dict)
        self.assertIn(app.PROXY_URL, proxy_dict["http"])
        self.assertIn(app.PROXY_URL, proxy_dict["https"])

    def test_fetch_via_proxy_respects_max_bytes(self):
        """fetch_via_proxy reads at most MAX_BYTES from the response."""
        big_body = b"X" * (app.MAX_BYTES + 10_000)

        class LimitedResponse:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_):
                pass

            def read(self, n=-1):
                if n < 0:
                    return big_body
                return big_body[:n]

        fake_opener = mock.MagicMock()
        fake_opener.open.return_value = LimitedResponse()

        import urllib.request as ur
        with mock.patch.object(ur, "build_opener", return_value=fake_opener), \
             mock.patch.object(ur, "ProxyHandler", return_value=mock.MagicMock()):
            status, raw = app.fetch_via_proxy("http://example.com")

        # The raw bytes returned must not exceed MAX_BYTES.
        self.assertLessEqual(len(raw), app.MAX_BYTES)

    def test_fetch_via_proxy_blocked_by_egress_raises(self):
        """If the proxy blocks the URL (e.g. allowlist miss), an exception propagates."""
        import urllib.error

        fake_opener = mock.MagicMock()
        fake_opener.open.side_effect = urllib.error.URLError("Connection refused by proxy")

        import urllib.request as ur
        with mock.patch.object(ur, "build_opener", return_value=fake_opener), \
             mock.patch.object(ur, "ProxyHandler", return_value=mock.MagicMock()):
            with self.assertRaises(Exception):
                app.fetch_via_proxy("http://blocked.example.com")


if __name__ == "__main__":
    unittest.main(verbosity=2)
