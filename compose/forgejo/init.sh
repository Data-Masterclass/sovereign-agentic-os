#!/bin/sh
# Creates the Forgejo admin user. The chart's own bootstrap (an
# initContainer script baked into the forgejo subchart's image) isn't
# shipped in the plain code.forgejo.org/forgejo/forgejo:11-rootless image,
# so this calls `forgejo admin user create` directly instead, sharing the
# server's app-data volume.
#
# Deliberately omits `-c/--config`: passing the container's own default
# app.ini path explicitly makes `MustInstalled()` fail even though it's the
# same file the running server uses — a quirk of this Forgejo version, not
# something to "fix" here, just avoid.
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
