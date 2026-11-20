# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""WP-14: how the query-tool logs in to Trino's TLS port (design 06 §5.2, option B).

The query-tool is os-ui's door to Trino until WP-36. On the TLS port it authenticates as the
service user `svc-os-ui` (Trino's PASSWORD file authenticator) and sets the session user to the
principal os-ui chose, so Trino asks OPA `ImpersonateUser` (svc-os-ui -> principal). A principal
that is itself a direct service user with its own mounted password (the delete-domain purge user)
logs in as itself instead, because nobody may impersonate it. With no `TRINO_AUTH_USER` the
query-tool connects exactly as today (no Authorization header).

The real-Trino proof is `test_trino_tls_int.py` (CI job `test-lakehouse`).
"""
import os
import tempfile
import unittest

import _stubs

STUB = _stubs.install()

from trino_login import LoginError, login_for, tls_client_kwargs  # noqa: E402


class LoginFor(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.write("svc-os-ui", "ui-secret\n")
        self.write("os-domain-delete", "purge-secret")

    def write(self, name, value):
        with open(os.path.join(self.dir, name), "w", encoding="utf-8") as f:
            f.write(value)

    def test_no_auth_user_is_todays_unauthenticated_connection(self):
        self.assertIsNone(login_for("alice@x.com", auth_user="", password_dir=self.dir))
        self.assertEqual(tls_client_kwargs(None, ca_file="/ca.crt"), {})

    def test_a_principal_is_impersonated_by_svc_os_ui(self):
        self.assertEqual(login_for("alice@x.com", auth_user="svc-os-ui", password_dir=self.dir), ("svc-os-ui", "ui-secret"))
        self.assertEqual(login_for("sales", auth_user="svc-os-ui", password_dir=self.dir), ("svc-os-ui", "ui-secret"))

    def test_a_direct_service_user_logs_in_as_itself(self):
        self.assertEqual(login_for("os-domain-delete", auth_user="svc-os-ui", password_dir=self.dir), ("os-domain-delete", "purge-secret"))

    def test_no_password_fails_closed(self):
        os.remove(os.path.join(self.dir, "svc-os-ui"))
        with self.assertRaises(LoginError):
            login_for("alice@x.com", auth_user="svc-os-ui", password_dir=self.dir)

    def test_empty_password_fails_closed(self):
        self.write("svc-os-ui", "\n")
        with self.assertRaises(LoginError):
            login_for("alice@x.com", auth_user="svc-os-ui", password_dir=self.dir)

    def test_a_path_in_the_principal_never_selects_another_file(self):
        for p in ("../svc-os-ui", "./os-domain-delete", "a/../os-domain-delete", ".hidden", "", None):
            self.assertEqual(login_for(p, auth_user="svc-os-ui", password_dir=self.dir)[0], "svc-os-ui", p)

    def test_tls_kwargs_force_https_and_the_ca(self):
        k = tls_client_kwargs(("svc-os-ui", "ui-secret"), ca_file="/etc/trino-ca/ca.crt")
        self.assertEqual(k["http_scheme"], "https")
        self.assertEqual(k["verify"], "/etc/trino-ca/ca.crt")
        self.assertEqual((k["auth"].username, k["auth"].password), ("svc-os-ui", "ui-secret"))

    def test_tls_without_a_ca_file_still_verifies(self):
        self.assertIs(tls_client_kwargs(("svc-os-ui", "p"), ca_file="")["verify"], True)


if __name__ == "__main__":
    unittest.main()
