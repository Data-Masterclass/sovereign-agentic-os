#!/bin/sh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# Dagster image tests against the REAL image (01 §7.1 tests 1–2), the eject test and the literal-safety test.
#   run.sh <image>          e.g. run.sh sovereign-os/dagster:test   (CI builds it first)
# Needs docker. Starts a stock Trino (tag read from the chart) and a bare python container with
# ONLY dbt-core + dbt-trino at the versions the image carries — read from the image, not repeated.
set -eu
IMAGE="${1:?usage: run.sh <dagster image>}"
REPO="$(cd "$(dirname "$0")/../../../../.." && pwd)"
VALUES="$REPO/charts/sovereign-agentic-os/values.yaml"
TRINO_TAG="$(awk '/repository: trinodb\/trino/{getline; gsub(/[" ]|tag:/,""); print; exit}' "$VALUES")"
NET="dagster-image-test-$$"
TRINO="trino-$$"

cleanup() { docker rm -f "$TRINO" >/dev/null 2>&1 || true; docker network rm "$NET" >/dev/null 2>&1 || true; }
trap cleanup EXIT

ONLY="${ONLY:-}" # image | eject | lakehouse | empty = all
if [ "$ONLY" = "lakehouse" ]; then exec sh "$REPO/images/extensions/dagster/tests/image/lakehouse.sh" "$IMAGE"; fi
if [ "$ONLY" != "eject" ]; then
  echo "== image tests in $IMAGE"
  docker run --rm -v "$REPO:/src:ro" -e SRC=/src "$IMAGE" python3 /src/images/extensions/dagster/tests/image/test_image.py
fi
[ "$ONLY" != "image" ] || exit 0

DBT_CORE="$(docker run --rm "$IMAGE" python3 -c 'import importlib.metadata as m; print(m.version("dbt-core"))')"
DBT_TRINO="$(docker run --rm "$IMAGE" python3 -c 'import importlib.metadata as m; print(m.version("dbt-trino"))')"
PY_BASE="$(awk '/^FROM /{print $2; exit}' "$REPO/images/extensions/dagster/Dockerfile")"
echo "== eject test: dbt-core $DBT_CORE + dbt-trino $DBT_TRINO on $PY_BASE, trinodb/trino:$TRINO_TAG"

docker network create "$NET" >/dev/null
# A stock Trino whose `iceberg` catalog is the memory connector: compile needs a live adapter
# connection (relation cache), not Iceberg itself. No OS component runs.
CAT="$(mktemp -d "${TMPDIR:-/tmp}/trino-cat.XXXXXX")"
printf 'connector.name=memory\n' > "$CAT/iceberg.properties"
chmod -R a+rX "$CAT"
docker run -d --name "$TRINO" --network "$NET" -v "$CAT:/etc/trino/catalog:ro" "trinodb/trino:$TRINO_TAG" >/dev/null
i=0
until docker exec "$TRINO" trino --execute 'select 1' >/dev/null 2>&1; do
  i=$((i + 1)); [ "$i" -lt 90 ] || { docker logs "$TRINO" | tail -40; echo "trino did not start"; exit 1; }
  sleep 2
done

docker run --rm --network "$NET" -v "$REPO:/src:ro" -e SRC=/src -e TRINO_HOST="$TRINO" "$PY_BASE" sh -c "
  set -e
  apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends git >/dev/null
  pip install -q --no-cache-dir --root-user-action=ignore 'dbt-core==$DBT_CORE' 'dbt-trino==$DBT_TRINO'
  if pip list 2>/dev/null | grep -iqE '^dagster'; then echo 'dagster must not be present'; exit 1; fi
  python3 /src/images/extensions/dagster/tests/image/eject.py
"

# Literal safety: real dbt parse + compile IN THE DAGSTER IMAGE on the generator's fuzz project and
# its legacy-strip twin, with Trino's query log as the side-effect oracle (literal_safety.py).
echo "== literal-safety: dbt parse + compile in $IMAGE against trinodb/trino:$TRINO_TAG"
docker run --rm --network "$NET" -v "$REPO:/src:ro" -e SRC=/src -e TRINO_HOST="$TRINO" "$IMAGE" \
  python3 /src/images/extensions/dagster/tests/image/literal_safety.py

# WP-49: the repo's own Dagster code location on Trino + Iceberg, the wrapper, the eject (lakehouse.sh).
[ "$ONLY" = "eject" ] || sh "$REPO/images/extensions/dagster/tests/image/lakehouse.sh" "$IMAGE"
