#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# AT-f eject for METRICS and DASHBOARDS on MetricFlow itself (design 11 A5 row d, A16 row d).
#   metricflow.sh <repo-dir written by gen-native-dashboard.ts> <work-dir>
# Stack: the chart's plain Postgres (Iceberg JDBC catalog) + the chart's trinodb/trino tag. Tools:
# the Dagster Dockerfile's python base (by digest) with ONLY dbt-core, dbt-trino, dbt-metricflow,
# metricflow (versions read from that Dockerfile; an unreadable pin fails the job) and
# vl-convert-python. No OS image, no OS process, no OS_* variable.
#   1. delete the OS layer (os/, dashboards/index.yml, dashboards/*/os.yaml, data/dagster/)
#   2. dbt parse + dbt build, mf validate-configs
#   3. mf query --saved-query <panel> for every panel; values asserted
#   4. vl-convert renders every panels/*.vl.json with the MetricFlow CSV inlined unchanged
#   5. NEGATIVE TWIN: a saved query naming an unknown metric fails dbt parse
#
# The connection profile. dbt and MetricFlow read the profile from DBT_PROFILES_DIR, which is
# user-side configuration by dbt's own design (https://docs.getdbt.com/docs/core/connect-data-platform/connection-profiles).
# The committed profiles.yml has a `local` target, but its DEFAULT target `trino` requires the
# OS-only env var OS_PRINCIPAL (impersonation_user), and `mf` has no --target flag and ignores
# DBT_TARGET. So the eject writes its own plain profile (the same profile name, one target, the
# committed `local` target's settings) outside the repo, and the repo's code is used as committed.
# Gap for the generator (WP-20): give the default target an OS-independent fallback.
set -euo pipefail
SRC="$1"; WORK="$2"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VALUES="$REPO_ROOT/charts/sovereign-agentic-os/values.yaml"
DOCKERFILE="$REPO_ROOT/images/extensions/dagster/Dockerfile"
die() { echo "FAIL $*"; exit 1; }

TRINO_TAG="$(awk '/repository: trinodb\/trino/{getline; gsub(/[" ]|tag:/,""); print; exit}' "$VALUES")"
[ -n "$TRINO_TAG" ] || die "no trinodb/trino tag in the chart"
PY_BASE="$(awk '/^FROM /{print $2; exit}' "$DOCKERFILE")"
case "$PY_BASE" in *@sha256:*) ;; *) die "Dockerfile base is not pinned by digest: '$PY_BASE'";; esac
PG_IMAGE="$(awk '/^  plainImage:/{f=1; next} f&&/repository:/{r=$2} f&&/tag:/{t=$2} f&&/digest:/{d=$2; exit} END{gsub(/"/,"",t); if (r && t && d) print r ":" t "@" d}' "$VALUES")"
[ -n "$PG_IMAGE" ] || die "no postgres.plainImage repository/tag/digest in the chart"
pin() {
  local p
  p="$(grep -o "\"$1==[^\"]*\"" "$DOCKERFILE" | head -1 | tr -d '"')" || true
  [ -n "$p" ] && [ "${p#*==}" != "" ] || die "no exact pin for $1 in $DOCKERFILE"
  printf '%s' "$p"
}
PINS="$(pin dbt-core) $(pin dbt-trino) $(pin 'dbt-metricflow\[dbt-trino\]') $(pin metricflow) vl-convert-python==1.8.0"
NET="mf-eject-$$"; PG="mf-eject-pg-$$"; TRINO="mf-eject-trino-$$"
cleanup() { docker rm -f "$PG" "$TRINO" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
echo "== $PY_BASE + $PINS ; trinodb/trino:$TRINO_TAG ; $PG_IMAGE"

mkdir -p "$WORK/cat" "$WORK/wh" "$WORK/profile"
chmod 0777 "$WORK/wh"
cp -R "$SRC" "$WORK/repo"
# The OS layer, deleted before any tool runs (design 11 §4.2).
rm -rf "$WORK/repo/os" "$WORK/repo/data/dagster" "$WORK/repo/dashboards/index.yml"
rm -f "$WORK"/repo/dashboards/*/os.yaml
PROFILE_NAME="$(awk -F': *' '/^profile:/{gsub(/["'\'']/,"",$2); print $2; exit}' "$WORK/repo/dbt_project.yml")"
[ -n "$PROFILE_NAME" ] || die "dbt_project.yml names no profile"
cat > "$WORK/profile/profiles.yml" <<P
$PROFILE_NAME:
  target: eject
  outputs:
    eject:
      type: trino
      method: none
      host: $TRINO
      port: 8080
      user: eject
      http_scheme: http
      catalog: iceberg
      schema: sales
      threads: 4
P
cat > "$WORK/cat/iceberg.properties" <<P
connector.name=iceberg
iceberg.catalog.type=jdbc
iceberg.jdbc-catalog.catalog-name=lakehouse
iceberg.jdbc-catalog.driver-class=org.postgresql.Driver
iceberg.jdbc-catalog.connection-url=jdbc:postgresql://$PG:5432/iceberg
iceberg.jdbc-catalog.connection-user=postgres
iceberg.jdbc-catalog.connection-password=pg
iceberg.jdbc-catalog.default-warehouse-dir=local:///wh
fs.native-local.enabled=true
local.location=/data
P
chmod -R a+rwX "$WORK"

docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=iceberg "$PG_IMAGE" >/dev/null
i=0; until docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 60 ] || die "postgres did not start"; sleep 1; done
sleep 2
docker exec -i "$PG" psql -q -v ON_ERROR_STOP=1 -U postgres -d iceberg <<'S'
CREATE TABLE iceberg_namespace_properties (catalog_name VARCHAR(255) NOT NULL, namespace VARCHAR(255) NOT NULL, property_key VARCHAR(255), property_value VARCHAR(1000), PRIMARY KEY (catalog_name, namespace, property_key));
CREATE TABLE iceberg_tables (catalog_name VARCHAR(255) NOT NULL, table_namespace VARCHAR(255) NOT NULL, table_name VARCHAR(255) NOT NULL, metadata_location VARCHAR(1000), previous_metadata_location VARCHAR(1000), iceberg_type VARCHAR(5), PRIMARY KEY (catalog_name, table_namespace, table_name));
S
docker run -d --name "$TRINO" --network "$NET" -v "$WORK/cat:/etc/trino/catalog:ro" -v "$WORK/wh:/data" "trinodb/trino:$TRINO_TAG" >/dev/null
i=0; until docker exec "$TRINO" trino --execute 'select 1' >/dev/null 2>&1; do i=$((i+1)); [ "$i" -lt 90 ] || { docker logs "$TRINO" | tail -30; die "trino did not start"; }; sleep 2; done
t() { docker exec "$TRINO" trino --execute "$1" >/dev/null; }
# The bronze landing the dbt sources name (in the OS the data-runner writes it; here plain SQL).
t "create schema iceberg.personal_amir"
t "create schema iceberg.sales"
t "create table iceberg.personal_amir.bronze_orders (order_id integer, order_date date, region varchar, net_amount double)"
t "insert into iceberg.personal_amir.bronze_orders values (1, DATE '2026-09-03', 'eu', 10.5), (2, DATE '2026-09-20', 'us', 20.0), (3, DATE '2026-10-02', 'eu', 1.5), (4, DATE '2026-10-15', 'us', 4.0)"

cat > "$WORK/in-container.sh" <<'IN'
set -euo pipefail
die() { echo "FAIL $*"; exit 1; }
read -ra pins <<< "$PINS"
[ "${#pins[@]}" -eq 5 ] || die "expected 5 pins, got '${PINS}'"
pip install -q --no-cache-dir --root-user-action=ignore "${pins[@]}" >/tmp/pip.log 2>&1 || { tail -20 /tmp/pip.log; die "pip install"; }
if env | grep -q '^OS_'; then die "an OS_ variable is set: $(env | grep '^OS_' | cut -d= -f1)"; fi
dbt parse -q
echo "ok   dbt parse"
dbt build -q --exclude 'test_type:data'
echo "ok   dbt build"
mf validate-configs --skip-dw >/tmp/validate.log 2>&1 || { tail -30 /tmp/validate.log; die "mf validate-configs"; }
grep -q 'ERRORS: 0' /tmp/validate.log || { tail -30 /tmp/validate.log; die "mf validate-configs reported errors"; }
echo "ok   mf validate-configs"
sqs="$(python3 -c "import json;print(' '.join(v['name'] for v in json.load(open('target/manifest.json'))['saved_queries'].values()))")"
[ -n "$sqs" ] || die "no saved queries in the manifest"
for sq in $sqs; do
  mf query --saved-query "$sq" --csv "/tmp/$sq.csv" >/tmp/mf.log 2>&1 || { tail -20 /tmp/mf.log; die "mf query --saved-query $sq"; }
  echo "ok   mf query --saved-query $sq: $(tr '\n' ' ' < "/tmp/$sq.csv")"
done
python3 - <<'PY'
import csv
r = {x['orders__region']: float(x['revenue']) for x in csv.DictReader(open('/tmp/sales_overview_revenue_by_region.csv'))}
assert r == {'us': 24.0, 'eu': 12.0}, r
print('ok   values: revenue us=24 eu=12')
PY
python3 - <<'PY'
import csv, glob, json, vl_convert as vlc
specs = sorted(glob.glob('dashboards/*/panels/*.vl.json'))
assert specs, 'no Vega-Lite panels'
for f in specs:
    spec = json.load(open(f)); name = spec['data']['name']
    rows = [{k: (float(v) if v.replace('.', '', 1).isdigit() else v) for k, v in r.items()} for r in csv.DictReader(open(f'/tmp/{name}.csv'))]
    fields = {spec['encoding'][c]['field'] for c in ('x', 'y')}
    assert rows and fields <= set(rows[0]), f'{f}: fields {fields} not in the MetricFlow output'
    spec['data'] = {'values': rows}
    png = vlc.vegalite_to_png(json.dumps(spec))
    assert png[:8] == b'\x89PNG\r\n\x1a\n', f'{f}: not a PNG'
    print(f'ok   vl-convert {f}: {len(png)} bytes, {len(rows)} rows')
PY
# NEGATIVE TWIN: a saved query on an unknown metric must fail dbt parse.
sed -i 's/^        - revenue$/        - no_such_metric/' dashboards/*/semantic.yml
grep -q 'no_such_metric' dashboards/*/semantic.yml || die "negative twin was not applied"
if dbt parse -q >/tmp/neg.log 2>&1; then die "negative twin parsed"; fi
grep -q 'no_such_metric' /tmp/neg.log || { tail -10 /tmp/neg.log; die "negative twin failed for another reason"; }
echo "ok   negative twin: unknown metric refused by dbt parse"
IN

docker run --rm --network "$NET" -v "$WORK/repo:/repo" -v "$WORK/profile:/profile:ro" -v "$WORK/in-container.sh:/in.sh:ro" -w /repo \
  -e HOME=/tmp -e DBT_PROFILES_DIR=/profile -e DBT_SEND_ANONYMOUS_USAGE_STATS=false -e PINS="$PINS" \
  "$PY_BASE" bash /in.sh
echo "metricflow eject: ok"
