#!/bin/sh
# Layer B (docker compose) — one-shot Forgejo admin bootstrap.
#
# The Helm chart's admin bootstrap (charts/sovereign-agentic-os/templates/gitea/
# — pulled read-only for Phase 2.1 investigation from the forgejo subchart
# v17.1.1) runs an initContainer executing /usr/local/bin/configure_gitea.sh,
# which is baked into that subchart's own container image build and was
# verified against Forgejo 11.0.16 (the same binary this compose file uses).
# That script is NOT shipped in the plain
# code.forgejo.org/forgejo/forgejo:11-rootless image (it belongs to the chart's
# init Secret, templated by Helm) — so it does not transfer to Compose. This
# script replicates the same end result (idempotent `admin user create`)
# directly against the forgejo CLI, verified empirically against this exact
# image/tag before being written:
#
#   * `forgejo admin user create` DOES support being invoked from a fresh,
#     separate one-shot container (not just via `docker exec` into the running
#     server), as long as it shares the server's app-data volume — confirmed.
#   * `-c/--config` must NOT be passed explicitly. Passing
#     `-c /var/lib/gitea/custom/conf/app.ini` (the container's own default
#     $GITEA_APP_INI) causes `MustInstalled()` to fail even though the exact
#     same config file the running server uses is right there — reproduced
#     3 times, including via `docker exec` into an already-healthy server.
#     Omitting -c and relying on the image's built-in $GITEA_APP_INI default
#     works every time. This looks like a bug in this Forgejo version, not
#     something we're free to "fix" — just avoid it.
#   * A second `admin user create` for the same username fails with exit 1 and
#     stdout/stderr `Command error: CreateUser: user already exists
#     [name: <user>]` — this is the ONLY failure mode we treat as success below,
#     so a genuine failure (bad DB, bad env, etc.) still propagates.
set -eu

USERNAME=${FORGEJO_ADMIN_USER:-gitea_admin}
PASSWORD=${FORGEJO_ADMIN_PASSWORD:-forgejo-admin-local-dev}
EMAIL=${FORGEJO_ADMIN_EMAIL:-admin@datamasterclass.com}

set +e
OUT=$(forgejo admin user create --admin --username "$USERNAME" --password "$PASSWORD" --email "$EMAIL" 2>&1)
CODE=$?
set -e

echo "$OUT"

if [ "$CODE" -eq 0 ]; then
  echo "admin user '$USERNAME' created"
  exit 0
fi

case "$OUT" in
  *"already exists"*)
    echo "admin user '$USERNAME' already exists -- idempotent, nothing to do"
    exit 0
    ;;
  *)
    echo "admin user create failed (exit $CODE)"
    exit "$CODE"
    ;;
esac
