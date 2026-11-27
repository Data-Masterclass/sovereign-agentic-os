#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# The chart renders Dagster's database password Secret (`dagster-postgresql`, key postgresql-password)
# from the dagster role's own password — the Secret the Dagster subchart reads when
# dagster.generatePostgresqlPasswordSecret is false and which nothing used to render (pilot install:
# every Dagster pod in CreateContainerConfigError). templates/base/postgres/credentials.yaml.
set -uo pipefail
cd "$(dirname "$0")/../.."
. scripts/tests/assert.sh
CHART=charts/sovereign-agentic-os
ls "$CHART"/charts/*.tgz >/dev/null 2>&1 || { [ -n "${CI:-}" ] && { echo "subcharts missing"; exit 1; }; echo "SKIP: subcharts not built"; exit 0; }
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
r() { out=$(helm template t "$CHART" -n agentic-os --skip-schema-validation "$@" 2>"$T/err"); rc=$?; err=$(cat "$T/err"); }
pw() { # pw <secret> <key>
  printf '%s' "$out" 2>/dev/null | python3 -c '
import sys, yaml
for d in yaml.safe_load_all(sys.stdin):
    if d and d.get("kind") == "Secret" and d["metadata"]["name"] == sys.argv[1]:
        print((d.get("stringData") or {}).get(sys.argv[2], "")); break
else: print("<absent>")' "$1" "$2"; }

r
rc_is "default render" 0
check "  dagster-postgresql is rendered" "dagster-local-dev" "$(pw dagster-postgresql postgresql-password)"
holds "  with the dagster role's password" [ "$(pw dagster-postgresql postgresql-password)" = "$(pw postgres-dagster-credentials password)" ]
check "  the Dagster pods read exactly that Secret" "name: dagster-postgresql" "$(printf '%s' "$out" | grep -A3 'name: DAGSTER_PG_PASSWORD')"

python3 - "$CHART/values.yaml" > "$T/rot.yaml" <<'PY'
import sys, yaml
dbs = yaml.safe_load(open(sys.argv[1]))["postgres"]["extraDatabases"]
for d in dbs:
    if d["name"] == "dagster": d["localPassword"] = "rotated-xyz"
print(yaml.safe_dump({"postgres": {"extraDatabases": dbs}}))
PY
r -f "$T/rot.yaml"
check "a rotated role password is followed" "rotated-xyz" "$(pw dagster-postgresql postgresql-password)"

r --set dagster.generatePostgresqlPasswordSecret=true --set dagster.postgresql.postgresqlPassword=sub-owned
holds "generatePostgresqlPasswordSecret=true: the chart does not render it (the subchart does)" \
  [ "$(printf '%s' "$out" | grep -c '^  name: dagster-postgresql$')" = 1 ]

r --set dagster.postgresql.postgresqlUsername=nobody
rc_is "a Dagster username with no extraDatabases role fails the render" 1
check "  saying why" "matches no postgres.extraDatabases role" "$err"

r --set externalSecrets.enabled=true --set externalSecrets.store.instanceId=x --set externalSecrets.store.username=y \
  --set 'externalSecrets.managed={dagster-postgresql}'
check "ESO-managed: the chart stops rendering it" "<absent>" "$(pw dagster-postgresql postgresql-password)"

r --set dagster.enabled=false
check "dagster off: not rendered" "<absent>" "$(pw dagster-postgresql postgresql-password)"
finish dagster-postgres-secret-chart && echo DAGSTER_POSTGRES_SECRET_CHART_OK
