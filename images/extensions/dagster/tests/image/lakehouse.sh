#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# WP-49 against REAL components: the OS-generated domain repo (golden `dlt-lakehouse`) runs as a
# plain Dagster code location on Trino + Iceberg, and the image only loads it.
#   lakehouse.sh <dagster image>
#
#   1. image  : `dagster definitions validate -m definitions` and `dagster dev` load the repo's own
#               module with the image's pinned Dagster; the platform wrapper (repo.py) loads the
#               same module from a repo-sync checkout, adds the run-pod env tags, and REFUSES a
#               tampered copy (C5).
#   2. eject  : a bare python container with ONLY dagster + dagster-dbt + dagster-dlt + dbt-trino + dlt at the
#               image's versions, a clone with `os/` DELETED, `dagster dev` up, then
#               `dagster asset materialize`: dlt `sql_table` lands Postgres rows in Iceberg through
#               Trino as the principal, dbt builds bronze → silver → gold, the adopted silver keeps
#               its Iceberg history, and a second sync is incremental (no duplicate rows).
#   3. negative twin: the same clone with `definitions.py` reading `os/schedules.yml` fails.
#
# The stack is small on purpose (Postgres + one Trino, ~2.5 GB): Postgres is both the Iceberg
# JDBC catalog store and the source database; Iceberg files live on Trino's local file system.
set -eu
IMAGE="${1:?usage: lakehouse.sh <dagster image>}"
REPO="$(cd "$(dirname "$0")/../../../../.." && pwd)"
HERE="$REPO/images/extensions/dagster/tests/image"
VALUES="$REPO/charts/sovereign-agentic-os/values.yaml"
TRINO_TAG="$(awk '/repository: trinodb\/trino/{getline; gsub(/[" ]|tag:/,""); print; exit}' "$VALUES")"
PG_IMAGE="postgres:17-alpine"
GOLDEN="$REPO/os-ui/tabs/data/lib/dbt/fixtures/dlt-lakehouse.golden.json"
# Under $HOME: a VM-backed docker (colima) shares the home directory, not macOS's temp dir.
mkdir -p "${LAKEHOUSE_TMP:-$HOME/.cache/lakehouse}"
WORK="$(mktemp -d "${LAKEHOUSE_TMP:-$HOME/.cache/lakehouse}/run.XXXXXX")"
NET="lakehouse-$$"; PG="lakehouse-pg-$$"; TRINO="lakehouse-trino-$$"
cleanup() { docker rm -f "$PG" "$TRINO" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; rm -rf "$WORK" 2>/dev/null || docker run --rm -v "$WORK:/w" alpine rm -rf /w/* >/dev/null 2>&1 || true; }
trap cleanup EXIT
FAIL=0
ok()   { echo "ok   $*"; }
bad()  { echo "FAIL $*"; FAIL=1; }
q()    { docker exec "$TRINO" trino --output-format TSV --execute "$1" 2>/dev/null; }

echo "== stack: $PG_IMAGE + trinodb/trino:$TRINO_TAG (Iceberg, JDBC catalog)"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" --network-alias pg -m 256m -e POSTGRES_PASSWORD=pg -e POSTGRES_DB=iceberg "$PG_IMAGE" >/dev/null
mkdir -p "$WORK/catalog" "$WORK/warehouse" && chmod 0777 "$WORK/warehouse"
cat > "$WORK/catalog/iceberg.properties" <<'EOF'
connector.name=iceberg
iceberg.catalog.type=jdbc
iceberg.jdbc-catalog.catalog-name=lakehouse
iceberg.jdbc-catalog.driver-class=org.postgresql.Driver
iceberg.jdbc-catalog.connection-url=jdbc:postgresql://pg:5432/iceberg
iceberg.jdbc-catalog.connection-user=postgres
iceberg.jdbc-catalog.connection-password=pg
iceberg.jdbc-catalog.default-warehouse-dir=local:///wh
fs.native-local.enabled=true
local.location=/data
EOF
chmod -R a+rX "$WORK/catalog"
i=0; until docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 60 ] || { echo "postgres did not start"; exit 1; }; sleep 1; done
sleep 2
# Trino's JDBC catalog does not create its tables (https://trino.io/docs/current/object-storage/metastores.html#jdbc-catalog).
docker exec -i "$PG" psql -q -v ON_ERROR_STOP=1 -U postgres -d iceberg <<'EOF'
CREATE TABLE iceberg_namespace_properties (catalog_name VARCHAR(255) NOT NULL, namespace VARCHAR(255) NOT NULL, property_key VARCHAR(255), property_value VARCHAR(1000), PRIMARY KEY (catalog_name, namespace, property_key));
CREATE TABLE iceberg_tables (catalog_name VARCHAR(255) NOT NULL, table_namespace VARCHAR(255) NOT NULL, table_name VARCHAR(255) NOT NULL, metadata_location VARCHAR(1000), previous_metadata_location VARCHAR(1000), iceberg_type VARCHAR(5), PRIMARY KEY (catalog_name, table_namespace, table_name));
CREATE DATABASE shop;
EOF
docker exec -i "$PG" psql -q -v ON_ERROR_STOP=1 -U postgres -d shop <<'EOF'
CREATE TABLE orders (id int primary key, customer text not null, amount numeric(10,2), updated_at timestamp);
INSERT INTO orders VALUES (1,'ann',10.50,'2026-11-01'),(2,'bob',20.00,'2026-11-02'),(3,'ann',5.25,'2026-11-03'),(4,'cy',0,'2026-11-03');
EOF
docker run -d --name "$TRINO" --network "$NET" --network-alias trino -m 2g -v "$WORK/catalog:/etc/trino/catalog:ro" -v "$WORK/warehouse:/data" "trinodb/trino:$TRINO_TAG" >/dev/null
i=0; until docker exec "$TRINO" trino --execute 'select 1' >/dev/null 2>&1; do i=$((i+1)); [ $i -lt 90 ] || { docker logs "$TRINO" | tail -30; echo "trino did not start"; exit 1; }; sleep 2; done

# The domain repo exactly as the OS generates it, in the design-12 layout.
SHA="$(python3 "$HERE/repo_v2.py" "$GOLDEN" "$WORK/origin")"
git clone -q "$WORK/origin" "$WORK/clone"
chmod -R a+rwX "$WORK/origin" "$WORK/clone"   # never the warehouse: Trino owns its files there

DAGSTER="$(docker run --rm "$IMAGE" python3 -c 'import importlib.metadata as m; print(m.version("dagster"))')"
pkg() { docker run --rm "$IMAGE" python3 -c "import importlib.metadata as m; print(m.version('$1'))"; }
echo "== image $IMAGE: dagster $DAGSTER"

# ---------------------------------------------------------------- 1a. validate + dagster dev ----
ENV_LOCAL="-e HOME=/tmp -e DAGSTER_HOME=/tmp/dh -e DBT_TARGET=local -e TRINO_HOST=trino -e TRINO_USER=alice -e DBT_SEND_ANONYMOUS_USAGE_STATS=false"
out="$(docker run --rm --network "$NET" -v "$WORK/clone:/repo" -w /repo/data/dagster $ENV_LOCAL "$IMAGE" sh -c '
  mkdir -p $DAGSTER_HOME && (cd ../dbt && dbt parse --profiles-dir . -q) && dagster definitions validate -m definitions' 2>&1)" \
  && ok "dagster definitions validate -m definitions (image, dagster $DAGSTER)" || { bad "definitions validate"; echo "$out" | tail -20; }

out="$(docker run --rm --network "$NET" -v "$WORK/clone:/repo" -w /repo/data/dagster $ENV_LOCAL "$IMAGE" sh -c '
  mkdir -p $DAGSTER_HOME && (dagster dev -m definitions -h 127.0.0.1 -p 3070 >/tmp/dev.log 2>&1 &) && python3 - <<PY
import json, time, urllib.request
Q = {"query": "{ assetNodes { assetKey { path } } repositoriesOrError { ... on RepositoryConnection { nodes { schedules { name } } } } }"}
for _ in range(120):
    try:
        r = json.load(urllib.request.urlopen(urllib.request.Request("http://127.0.0.1:3070/graphql", json.dumps(Q).encode(), {"content-type": "application/json"}), timeout=5))
        nodes = r["data"]["assetNodes"]
        if nodes:
            print("assets", sorted("/".join(n["assetKey"]["path"]) for n in nodes))
            print("schedules", sorted(s["name"] for n in r["data"]["repositoriesOrError"]["nodes"] for s in n["schedules"]))
            break
    except Exception:
        pass
    time.sleep(2)
else:
    print(open("/tmp/dev.log").read()[-3000:]); raise SystemExit("dagster dev did not load the location")
PY' 2>&1)"
if echo "$out" | grep -q "sales/landing_sales_alice/raw_shop_orders" && echo "$out" | grep -q "sales/personal_alice/gold_shop_orders" && echo "$out" | grep -q "sales__ds_shop0001"; then
  ok "dagster dev loads the module: $(echo "$out" | grep -c sales/) line(s) — $(echo "$out" | grep '^schedules')"
else bad "dagster dev"; echo "$out" | tail -20; fi

# ---------------------------------------------------------------- 1b. platform wrapper ----------
CO="$WORK/checkout"; mkdir -p "$CO/sales" "$CO/tampered"
git clone -q "$WORK/origin" "$CO/sales/$SHA" && ln -s "$SHA" "$CO/sales/current"
git clone -q "$WORK/origin" "$CO/tampered/$SHA" && ln -s "$SHA" "$CO/tampered/current"
printf '\nimport os\n' >> "$CO/tampered/$SHA/data/dagster/definitions.py"
chmod -R a+rwX "$CO"
out="$(docker run --rm --network none -v "$CO:/repos-checkout" -w /opt/dagster/app -e HOME=/tmp -e REPO_SYNC_CHECKOUT=/repos-checkout "$IMAGE" sh -c '
  for d in sales tampered; do python3 os_projects.py --parse /repos-checkout/$d/current/data/dbt >/dev/null || exit 3; done
  dagster definitions validate -f repo.py 2>&1 | tail -5
  python3 - <<PY
import json, logging, repo
s = repo.defs.get_schedule_def("sales__ds_shop0001")
env = {e["name"]: e["value"] for e in json.loads(s.tags["dagster-k8s/config"])["container_config"]["env"]}
print("schedule env", env["OS_PRINCIPAL"], env["DESTINATION__SQLALCHEMY__CREDENTIALS__USERNAME"], env["OS_PINNED_COMMITS"].split("=")[0])
print("domains", sorted({k.path[0] for k in repo.defs.resolve_all_asset_keys()}))
print("sensors", sorted(x.name for x in repo.defs.sensors))
PY' 2>&1)"
if echo "$out" | grep -q "schedule env alice alice sales" && echo "$out" | grep -q "domains \['sales'\]" && echo "$out" | grep -q "differs from the OS-generated"; then
  ok "wrapper loads the repo's definitions, adds the run-pod env, refuses the tampered copy (C5)"
else bad "platform wrapper"; echo "$out" | tail -25; fi

# ---------------------------------------------------------------- 2. eject: dagster dev + materialize
rm -rf "$WORK/clone/os"   # no OS layer at all
# An EXISTING silver table, as an out-of-band layer left it: adopting it must keep its history.
q "create schema if not exists iceberg.personal_alice" >/dev/null
q "create table iceberg.personal_alice.silver_shop_orders as select 99 as id, 'legacy' as customer, cast(1 as decimal(10,2)) as amount, timestamp '2026-10-01 00:00:00' as updated_at" >/dev/null
PY_BASE="$(awk '/^FROM /{print $2; exit}' "$REPO/images/extensions/dagster/Dockerfile")"
PINS="dagster==$DAGSTER dagster-webserver==$DAGSTER dagster-dbt==$(pkg dagster-dbt) dagster-dlt==$(pkg dagster-dlt) dbt-core==$(pkg dbt-core) dbt-trino==$(pkg dbt-trino) dlt[sqlalchemy,sql-database]==$(pkg dlt) trino[sqlalchemy]==$(pkg trino) psycopg2-binary==$(pkg psycopg2-binary) SQLAlchemy==$(pkg SQLAlchemy)"
echo "== eject: $PY_BASE + $PINS"
EJECT_ENV="$ENV_LOCAL -e SOURCES__CONN_SHOP__CREDENTIALS=postgresql+psycopg2://postgres:pg@pg:5432/shop -e DESTINATION__SQLALCHEMY__CREDENTIALS=trino://alice@trino:8080/iceberg"
EJECT_NAME="lakehouse-eject-$$"
docker run -d --name "$EJECT_NAME" --network "$NET" -v "$WORK/clone:/repo" -w /repo/data/dagster $EJECT_ENV "$PY_BASE" sleep 3600 >/dev/null
trap 'docker rm -f "$EJECT_NAME" >/dev/null 2>&1; cleanup' EXIT
ej() { docker exec "$EJECT_NAME" sh -c "$1"; }
out="$(ej "set -e
  pip install -q --no-cache-dir --root-user-action=ignore $PINS >/dev/null 2>&1
  if env | grep -q '^OS_'; then echo 'an OS_ variable is set'; exit 1; fi
  mkdir -p \$DAGSTER_HOME
  (dagster dev -m definitions -h 127.0.0.1 -p 3070 >/tmp/dev.log 2>&1 &)
  for i in \$(seq 1 120); do python3 -c 'import urllib.request; urllib.request.urlopen(\"http://127.0.0.1:3070/server_info\", timeout=3)' 2>/dev/null && break; sleep 2; done
  dagster asset materialize -m definitions --select '*' 2>&1 | tail -2" 2>&1)" && ok "eject: dagster dev up and \`dagster asset materialize --select '*'\` succeeded with no OS" || { bad "eject materialize"; echo "$out" | tail -40; }
# A new source row, then the scheduled sync's own job: dlt loads only the new row, dbt appends it once.
docker exec "$PG" psql -q -U postgres -d shop -c "INSERT INTO orders VALUES (5,'bob',7.00,'2026-11-05')"
out="$(ej "dagster job execute -m definitions -j sales__ds_shop0001 2>&1 | tail -2" 2>&1)" && ok "eject: the sync job sales__ds_shop0001 ran" || { bad "eject sync job"; echo "$out" | tail -30; }
landing="$(q 'select count(*) from iceberg.landing_sales_alice.raw_shop_orders' | tr -d '"')"
bronze="$(q 'select count(*) from iceberg.personal_alice.bronze_shop_orders' | tr -d '"')"
silver="$(q 'select count(*) from iceberg.personal_alice.silver_shop_orders' | tr -d '"')"
gold="$(q "select customer || ':' || cast(orders as varchar) from iceberg.personal_alice.gold_shop_orders order by 1" | tr -d '"' | tr '\n' ' ')"
snaps="$(q 'select count(*) from iceberg.personal_alice."silver_shop_orders$snapshots"' | tr -d '"')"
# Trino records the writing user in every Iceberg snapshot summary (`trino_user`).
writer="$(q "select distinct summary['trino_user'] from iceberg.landing_sales_alice.\"raw_shop_orders\$snapshots\"" | tr -d '"' | tr '\n' ' ')"
echo "   landing=$landing bronze=$bronze silver=$silver gold=[$gold] silver_snapshots=$snaps dlt_writer=[$writer]"
[ "$landing" = 5 ] && ok "landing: dlt sql_table loaded 4 rows, then only the 1 new row (incremental cursor)" || bad "landing rows = $landing, want 5"
[ "$bronze" = 5 ] && ok "bronze: dbt incremental model over the landing, no row twice (5 rows)" || bad "bronze rows = $bronze, want 5"
[ "$silver" = 4 ] && ok "silver: the authored model rebuilt from bronze (4 rows with amount > 0; the legacy row replaced)" || bad "silver rows = $silver, want 4"
[ "$gold" = "ann:2 bob:2 " ] && ok "gold: built by dbt from silver" || bad "gold = [$gold]"
[ "${snaps:-0}" -ge 2 ] && ok "adopted silver kept its Iceberg history ($snaps snapshots)" || bad "silver snapshots = $snaps, want >= 2"
case "$writer" in alice|"alice ") ok "dlt wrote through Trino as the principal (alice)";; *) bad "dlt writer = [$writer]";; esac

# ---------------------------------------------------------------- 3. negative twin -------------
python3 "$HERE/repo_v2.py" "$GOLDEN" "$WORK/neg" --tamper-os-read >/dev/null
rm -rf "$WORK/neg/os" && chmod -R a+rwX "$WORK/neg"
if docker run --rm --network "$NET" -v "$WORK/neg:/repo" -w /repo/data/dagster $ENV_LOCAL "$IMAGE" sh -c 'mkdir -p $DAGSTER_HOME && (cd ../dbt && dbt parse --profiles-dir . -q) && dagster definitions validate -m definitions' >"$WORK/neg.log" 2>&1; then
  bad "negative twin: definitions.py reading os/schedules.yml still loaded without the OS"
else
  grep -q "schedules.yml" "$WORK/neg.log" && ok "negative twin: definitions.py reading os/schedules.yml fails without the OS" || { bad "negative twin failed for another reason"; tail -5 "$WORK/neg.log"; }
fi

[ $FAIL = 0 ] && echo "lakehouse: ok" || { echo "lakehouse: FAIL"; exit 1; }
