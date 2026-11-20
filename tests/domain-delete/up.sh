#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Delete-domain harness: the lakehouse harness (chart Trino + Polaris on Postgres + OPA + MinIO,
# tests/lakehouse/render.py) under its OWN compose project, plus OpenSearch (the upstream image
# images/extensions/opensearch is built FROM) and LiteLLM (the chart's image) on its own Postgres.
#
#   bash tests/domain-delete/up.sh     # prints the env the os-ui test needs (also in $WORK/test.env)
#   bash tests/domain-delete/down.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
P=${DD_PROJECT:-soa-domain-delete}
bash tests/domain-delete/down.sh >/dev/null 2>&1 || true
WORK=${DD_WORK:-$(mktemp -d "${DD_WORK_PARENT:-$HOME}/.soa-domain-delete.XXXXXX")}
rand() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
export LH_S3_KEY="ci$(rand 8)" LH_S3_SECRET="$(rand 20)" LH_PG_USER=polaris LH_PG_PASSWORD="$(rand 16)"
# The purge window is OPEN in this harness (the chart default is off).
python3 tests/lakehouse/render.py "$WORK" --set polaris.purge.enabled=true "$@"
# The query-tool image is ours: build it under the chart's ref (the purge Job and the query-tool
# service both run it).
QT_REF=$(python3 -c "import yaml; v=yaml.safe_load(open('charts/sovereign-agentic-os/values.yaml'))['queryTool']['image']; print(v['repository']+':'+v['tag'])")
docker build -q -t "$QT_REF" images/extensions/query-tool >/dev/null
chmod -R a+rX "$WORK"
chmod a+rwx "$WORK/trino/etc/catalog"   # the polaris-purge Job writes the purge catalog here
# Images from what ships: OpenSearch = the FROM line of the image we build; LiteLLM = the chart pin.
OS_IMAGE=$(sed -n 's/^FROM //p' images/extensions/opensearch/Dockerfile | head -1)
LITELLM_IMAGE=$(python3 - <<'PY'
import yaml
v = yaml.safe_load(open('charts/sovereign-agentic-os/values.yaml'))['litellm']['image']
print(f"{v['repository']}:{v['tag']}")
PY
)
{
  cat "$WORK/compose.env"
  echo "LH_WORK=$WORK"; echo "LH_PG_USER=$LH_PG_USER"; echo "LH_PG_PASSWORD=$LH_PG_PASSWORD"
  echo "LH_TRINO_PORT=${DD_TRINO_PORT:-18580}"
  echo "DD_OPENSEARCH_IMAGE=$OS_IMAGE"; echo "DD_LITELLM_IMAGE=$LITELLM_IMAGE"; echo "DD_QUERY_TOOL_IMAGE=$QT_REF"
  echo "DD_LITELLM_DB_PASSWORD=$(rand 12)"; echo "DD_LITELLM_MASTER_KEY=sk-dd-$(rand 12)"
} > "$WORK/compose.all.env"
echo "$WORK" > "${TMPDIR:-/tmp}/$P.work"
C="docker compose -p $P -f tests/lakehouse/compose.yaml -f tests/domain-delete/compose.override.yaml --env-file $WORK/compose.all.env"
if ! $C up -d --wait --wait-timeout 900 trino trino-opa query-tool opensearch litellm; then
  $C ps -a; $C logs --tail 80; exit 1
fi
val() { sed -n "s/^$1=//p" "$WORK/compose.all.env" | head -1; }
DD_LITELLM_MASTER_KEY=$(val DD_LITELLM_MASTER_KEY)
cat > "$WORK/test.env" <<ENV
DD_IT=1
LH_TRINO_URL=http://127.0.0.1:${DD_TRINO_PORT:-18580}
QUERY_TOOL_URL=http://127.0.0.1:${DD_QUERY_TOOL_PORT:-18585}
DOMAIN_DELETE_PURGE_ENABLED=true
OPA_URL=http://127.0.0.1:${DD_OPA_PORT:-18581}
DD_S3_URL=http://127.0.0.1:${DD_MINIO_PORT:-18582}
DD_S3_KEY=$LH_S3_KEY
DD_S3_SECRET=$LH_S3_SECRET
OPENSEARCH_URL=http://127.0.0.1:${DD_OPENSEARCH_PORT:-18583}
LITELLM_URL=http://127.0.0.1:${DD_LITELLM_PORT:-18584}
LITELLM_MASTER_KEY=$DD_LITELLM_MASTER_KEY
ENV
echo "up.sh: domain-delete harness up; env in $WORK/test.env"
