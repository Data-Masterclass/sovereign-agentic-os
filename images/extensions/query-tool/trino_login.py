# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
"""How the query-tool logs in to Trino's TLS port (WP-14; design 06 §5.2, option B).

Off (no `TRINO_AUTH_USER`): the connection is exactly today's, with no Authorization header.

On: the query-tool authenticates as the service user `TRINO_AUTH_USER` (`svc-os-ui`) with the
password the chart mounts at `TRINO_PASSWORD_DIR/<user>` (Trino's PASSWORD file authenticator,
https://trino.io/docs/476/security/password-file.html), over HTTPS that trusts only the chart CA
(`TRINO_CA_FILE`). The session user stays the principal os-ui chose, so Trino asks OPA
`ImpersonateUser` (svc-os-ui -> principal; policies/trino_impersonation.rego). A principal that is
itself a direct service user with its own mounted password (the delete-domain purge user) logs in
as itself, because nobody may impersonate it.

Fails closed: a configured login without a readable, non-empty password raises `LoginError`
rather than connecting as somebody else. Never logs a password. Stdlib only, apart from the
lazy `trino.auth` import in `tls_client_kwargs`.
"""
import os
import re

# A principal may name its own password file only if it is a plain identifier (no path parts).
_DIRECT = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._@+-]{0,127}$")


class LoginError(RuntimeError):
    """A login is configured but cannot be made (no or empty password)."""


def _password(password_dir: str, user: str) -> str:
    path = os.path.join(password_dir, user)
    try:
        with open(path, encoding="utf-8") as f:
            value = f.read().strip()
    except OSError as e:
        raise LoginError(f"no Trino password mounted for {user}") from e
    if not value:
        raise LoginError(f"empty Trino password for {user}")
    return value


def login_for(session_user, *, auth_user: str, password_dir: str):
    """The (user, password) to authenticate as, or None for today's unauthenticated connection."""
    if not auth_user:
        return None
    if (isinstance(session_user, str) and _DIRECT.match(session_user) and ".." not in session_user
            and session_user != auth_user and os.path.isfile(os.path.join(password_dir, session_user))):
        return session_user, _password(password_dir, session_user)
    return auth_user, _password(password_dir, auth_user)


def tls_client_kwargs(login, *, ca_file: str) -> dict:
    """trino.dbapi.connect kwargs for `login`: Basic auth over HTTPS, verified against the CA."""
    if login is None:
        return {}
    from trino.auth import BasicAuthentication

    return {
        "auth": BasicAuthentication(login[0], login[1]),
        "http_scheme": "https",
        "verify": ca_file or True,
    }
