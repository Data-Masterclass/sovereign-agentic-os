# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""WP-14, real Trino: the query-tool's own connection code over Trino 476's TLS port.

Runs in CI job `test-lakehouse` against the chart's Trino (tests/lakehouse) with the real
`trino` client from requirements.txt, never the stubs:

    LH_WORK=<harness work dir> python3 images/extensions/query-tool/tests/test_trino_tls_int.py

It builds the connection exactly as app._connect does (connect_kwargs + trino_login) and checks:
the session user is the principal (svc-os-ui impersonating it), Trino's OPA plugin denies a
principal svc-os-ui may not act for, and a wrong password is refused. Skipped (not run) under
`unittest discover` without a harness.
"""
import json
import os
import sys
import tempfile
import unittest

import _stubs  # noqa: F401,E402 -- only for the package dir on sys.path; the stubs are NOT installed here

WORK = os.environ.get("LH_WORK", "")
SECRETS = os.path.join(WORK, "test-secrets.json") if WORK else ""
RUN = bool(SECRETS) and os.path.isfile(SECRETS) and "trino" not in sys.modules


@unittest.skipUnless(RUN, "needs the lakehouse harness (LH_WORK) and the real trino client")
class QueryToolOverTls(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import trino  # the real client, requirements.txt

        cls.trino = trino
        sec = json.load(open(SECRETS, encoding="utf-8"))
        cls.ca = os.path.join(WORK, "trino-ca.crt")
        with open(cls.ca, "w", encoding="utf-8") as f:
            f.write(sec["ca"])
        cls.pwdir = tempfile.mkdtemp()
        with open(os.path.join(cls.pwdir, "svc-os-ui"), "w", encoding="utf-8") as f:
            f.write(sec["passwords"]["svc-os-ui"])
        cls.port = int(os.environ.get("LH_TRINO_TLS_PORT", "18443"))

    def connect(self, principal, password_dir=None):
        from execute_guard import connect_kwargs
        from trino_login import login_for, tls_client_kwargs

        kwargs = connect_kwargs(principal, "information_schema", host="127.0.0.1", port=self.port, catalog="system",
                                http_scheme="http", default_user="query-agent", request_timeout=60,
                                max_run_time="60s", source="os-ui/parity/query")
        login = login_for(kwargs["user"], auth_user="svc-os-ui", password_dir=password_dir or self.pwdir)
        kwargs.update(tls_client_kwargs(login, ca_file=self.ca))
        return self.trino.dbapi.connect(**kwargs)

    def one(self, conn, sql):
        cur = conn.cursor()
        cur.execute(sql)
        return cur.fetchall()

    def test_session_user_is_the_principal(self):
        # `sales` is a chart-seeded governance principal (values opa.governance.principals).
        self.assertEqual(self.one(self.connect("sales"), "SELECT current_user"), [["sales"]])

    def test_a_principal_svc_os_ui_may_not_act_for_is_denied(self):
        with self.assertRaises(self.trino.exceptions.TrinoUserError) as e:
            self.one(self.connect("svc-os-worker"), "SELECT current_user")
        self.assertEqual(e.exception.error_name, "PERMISSION_DENIED")

    def test_a_wrong_password_is_refused(self):
        bad = tempfile.mkdtemp()
        with open(os.path.join(bad, "svc-os-ui"), "w", encoding="utf-8") as f:
            f.write("not-the-password")
        with self.assertRaises(Exception) as e:
            self.one(self.connect("sales", password_dir=bad), "SELECT 1")
        self.assertIn("401", str(e.exception))


if __name__ == "__main__":
    unittest.main()
