# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""WP-13: os-ui's Trino `source` and client tags reach the Trino connection unchanged.

Trino's resource-group selector reads the source (`os-ui/<domain>/<surface>` →
`global.domains.<domain>.<user>`, design 06 §5.5). The live proof is
tests/lakehouse/limits.int.test.mjs on the chart's Trino; this pins the pass-through.
"""
import unittest

import _stubs

STUB = _stubs.install()

from execute_guard import MCP_SOURCE, ExecuteError, connect_kwargs, scheduling  # noqa: E402

BASE = dict(host="trino", port=8080, catalog="iceberg", http_scheme="http", default_user="query-agent")


class Scheduling(unittest.TestCase):
    def test_source_and_tags_pass_through(self):
        k = connect_kwargs("u1", "sales", source="os-ui/sales/data-query",
                           client_tags=["os-ui", "domain=sales", "surface=data-query"], **BASE)
        self.assertEqual(k["source"], "os-ui/sales/data-query")
        self.assertEqual(k["client_tags"], ["os-ui", "domain=sales", "surface=data-query"])

    def test_no_silent_fallback(self):
        # An untagged statement would land in Trino's catch-all group: refused, never defaulted.
        with self.assertRaises(ValueError):
            connect_kwargs("u1", "sales", **BASE)
        with self.assertRaises(ExecuteError) as e:
            scheduling({"sql": "select 1"})
        self.assertEqual(e.exception.status, 400)
        self.assertEqual(MCP_SOURCE, "query-tool/mcp")

    def test_body_shape_is_checked(self):
        self.assertEqual(scheduling({"source": "os-ui/sales/x", "client_tags": ["a=b"]}), ("os-ui/sales/x", ["a=b"]))
        for bad in ({"source": "os-ui/s\r\nX-Trino-User: root"}, {"source": 5}, {"client_tags": "a"},
                    {"client_tags": ["a,b"]}, {"client_tags": ["x"] * 9}):
            with self.assertRaises(ExecuteError):
                scheduling(bad)


if __name__ == "__main__":
    unittest.main()
