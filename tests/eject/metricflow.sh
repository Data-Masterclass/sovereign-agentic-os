#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# AT-f eject for METRICS and DASHBOARDS on MetricFlow itself (design 11 A5 row d, A16 row d).
#   metricflow.sh <repo-dir written by gen-native-dashboard.ts> <work-dir>
# Stack: postgres:17-alpine (Iceberg JDBC catalog) + the chart's trinodb/trino tag. Tools: a bare
# python base with ONLY dbt-core, dbt-trino, dbt-metricflow, metricflow (versions read from the
# Dagster Dockerfile, never typed here) and vl-convert-python. No OS image, no OS process.
#   1. delete the OS layer (os/, dashboards/index.yml, dashboards/*/os.yaml, data/dagster/)
#   2. dbt parse + dbt build --target local, mf validate-configs
#   3. mf query --saved-query <panel> for every panel; values asserted
#   4. vl-convert renders every panels/*.vl.json with the MetricFlow CSV inlined unchanged
#   5. NEGATIVE TWIN: a saved query naming an unknown metric fails dbt parse
set -eu
SRC="$1"; WORK="$2"
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
VALUES="$REPO_ROOT/charts/sovereign-agentic-os/values.yaml"
DOCKERFILE="$REPO_ROOT/images/extensions/dagster/Dockerfile"
TRINO_TAG="$(awk '/repository: trinodb\/trino/{getline; gsub(/[" ]|tag:/,""); print; exit}' "$VALUES")"
PY_BASE="$(awk '/^FROM /{print $2; exit}' "$DOCKERFILE")"
pin() { grep -o "\"$1==[^\"]*\"" "$DOCKERFILE" | head -1 | tr -d '"'; }
PINS="$(pin dbt-core) $(pin dbt-trino) $(pin 'dbt-metricflow\[dbt-trino\]') $(pin metricflow) vl-convert-python==1.8.0"
NET="mf-eject-$$"; PG="mf-eject-pg-$$"; TRINO="mf-eject-trino-$$"
cleanup() { docker rm -f "$PG" "$TRINO" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT
echo "== $PY_BASE + $PINS ; trinodb/trino:$TRINO_TAG"
mkdir -p "$WORK/cat" "$WORK/wh" && chmod 0777 "$WORK/wh"
cp -R "$SRC" "$WORK/repo"
# The OS layer, deleted before any tool runs (design 11 §4.2).
( cd "$WORK/repo" && rm -rf os data/dagster dashboards/index.yml && rm -f dashboards/*/os.yaml )
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
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=iceberg postgres:17-alpine >/dev/null
i=0; until docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 60 ] || exit 1; sleep 1; done; sleep 2
docker exec -i "$PG" psql -q -v ON_ERROR_STOP=1 -U postgres -d iceberg <<'S'
CREATE TABLE iceberg_namespace_properties (catalog_name VARCHAR(255) NOT NULL, namespace VARCHAR(255) NOT NULL, property_key VARCHAR(255), property_value VARCHAR(1000), PRIMARY KEY (catalog_name, namespace, property_key));
CREATE TABLE iceberg_tables (catalog_name VARCHAR(255) NOT NULL, table_namespace VARCHAR(255) NOT NULL, table_name VARCHAR(255) NOT NULL, metadata_location VARCHAR(1000), previous_metadata_location VARCHAR(1000), iceberg_type VARCHAR(5), PRIMARY KEY (catalog_name, table_namespace, table_name));
S
docker run -d --name "$TRINO" --network "$NET" -v "$WORK/cat:/etc/trino/catalog:ro" -v "$WORK/wh:/data" "trinodb/trino:$TRINO_TAG" >/dev/null
i=0; until docker exec "$TRINO" trino --execute 'select 1' >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 90 ] || { docker logs "$TRINO" | tail -30; exit 1; }; sleep 2; done
t() { docker exec "$TRINO" trino --execute "$1" >/dev/null 2>&1; }
# The bronze landing the dbt sources name (in the OS the data-runner writes it; here plain SQL).
t "create schema iceberg.personal_amir"; t "create schema iceberg.sales"
t "create table iceberg.personal_amir.bronze_orders (order_id integer, order_date date, region varchar, net_amount double)"
t "insert into iceberg.personal_amir.bronze_orders values (1, DATE '2026-09-03', 'eu', 10.5), (2, DATE '2026-09-20', 'us', 20.0), (3, DATE '2026-10-02', 'eu', 1.5), (4, DATE '2026-10-15', 'us', 4.0)"

docker run --rm --network "$NET" -v "$WORK/repo:/repo" -w /repo -e HOME=/tmp -e TRINO_HOST="$TRINO" -e TRINO_USER=eject \
  -e DBT_SEND_ANONYMOUS_USAGE_STATS=false "$PY_BASE" sh -c "
set -e
pip install -q --no-cache-dir --root-user-action=ignore $PINS >/dev/null 2>&1
if env | grep -q '^OS_'; then echo 'an OS_ variable is set'; exit 1; fi
dbt parse --profiles-dir . --target local -q && echo 'ok   dbt parse'
dbt build --profiles-dir . --target local -q --exclude 'test_type:data' && echo 'ok   dbt build'
# KNOWN GAP (audit 2026-11-21): MetricFlow reads the profile's DEFAULT target, which requires the
# OS-only env var OS_PRINCIPAL (impersonation_user). Plain Trino accepts any principal; set it here
# until the generator gives the default target an OS-independent fallback.
export OS_PRINCIPAL=eject
mf validate-configs --skip-dw 2>&1 | grep -q 'ERRORS: 0' && echo 'ok   mf validate-configs'
for sq in \$(python3 -c \"import json;print(' '.join(v['name'] for v in json.load(open('target/manifest.json'))['saved_queries'].values()))\"); do
  mf query --saved-query \$sq --csv /tmp/\$sq.csv >/tmp/mf.log 2>&1 || { tail -20 /tmp/mf.log; exit 1; }
  echo \"ok   mf query --saved-query \$sq: \$(tr '\n' ' ' < /tmp/\$sq.csv)\"
done
python3 -c \"import csv; r={x['orders__region']: float(x['revenue']) for x in csv.DictReader(open('/tmp/sales_overview_revenue_by_region.csv'))}; assert r == {'us': 24.0, 'eu': 12.0}, r\" && echo 'ok   values: revenue us=24 eu=12' || { echo 'FAIL revenue by region'; exit 1; }
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
    print(f'ok   vl-convert {f}: {len(png)} bytes, {len(rows)} rows')
PY
# NEGATIVE TWIN: a saved query on an unknown metric must fail dbt parse.
sed -i 's/^        - revenue\$/        - no_such_metric/' dashboards/*/semantic.yml
if dbt parse --profiles-dir . --target local -q >/tmp/neg.log 2>&1; then echo 'FAIL negative twin parsed'; exit 1; fi
grep -q 'no_such_metric' /tmp/neg.log && echo 'ok   negative twin: unknown metric refused by dbt parse'
"
echo "metricflow eject: ok"
