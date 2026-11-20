#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-56 harness: a REAL S3 store (SeaweedFS, Apache-2.0 — the WP-21 pin), a REAL Postgres 17
# (the chart's `postgres.plainImage`) and the backup-tools image built from
# images/base/backup-tools. The chart's scripts (charts/sovereign-agentic-os/files/backup) run
# unchanged inside those images.
#
#   bash tests/backup/up.sh     # idempotent
#   bash tests/backup/down.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
P=${SOA_BK_PREFIX:-soa-bk}
WORK=${SOA_BK_WORK:-$(mktemp -d)}
SEAWEED=chrislusf/seaweedfs:4.52@sha256:57877e32bb90073b37dc109b438ba66e84fd5ed9ced5f5c04f56444ef243ce59
PG=$(python3 -c "import yaml;v=yaml.safe_load(open('charts/sovereign-agentic-os/values.yaml'))['postgres']['plainImage'];print(f\"{v['repository']}:{v['tag']}@{v['digest']}\")")

bash tests/backup/down.sh >/dev/null 2>&1 || true
docker build -q -t soa-backup-tools:wp56 images/base/backup-tools >/dev/null
docker network create "$P" >/dev/null

AK=ci$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n'); SK=$(od -An -N20 -tx1 /dev/urandom | tr -d ' \n')
mkdir -p "$WORK/seaweed" "$WORK/repos" "$WORK/results"
cat > "$WORK/seaweed/s3.json" <<JSON
{"identities":[{"name":"backup","credentials":[{"accessKey":"$AK","secretKey":"$SK"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON
printf 'AWS_ACCESS_KEY_ID=%s\nAWS_SECRET_ACCESS_KEY=%s\nAWS_DEFAULT_REGION=eu01\nS3_ENDPOINT=http://s3:8333\n' "$AK" "$SK" > "$WORK/s3.env"
chmod -R a+rwX "$WORK"
docker run -d --name "$P-s3" --network "$P" --network-alias s3 \
  -v "$WORK/seaweed/s3.json:/etc/seaweedfs/s3.json:ro" \
  "$SEAWEED" server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json -master.volumeSizeLimitMB=64 >/dev/null
docker run -d --name "$P-pg" --network "$P" --network-alias pg -e POSTGRES_PASSWORD=ci-only "$PG" >/dev/null

for b in soa-bundles soa-pgdump; do
  for i in $(seq 1 60); do
    docker exec "$P-s3" sh -c "echo 's3.bucket.create -name $b' | weed shell" >/dev/null 2>&1 || true
    docker exec "$P-s3" sh -c "echo 's3.bucket.list' | weed shell" 2>/dev/null | grep -q "$b" && break
    sleep 2
  done
done
for i in $(seq 1 60); do docker exec "$P-pg" pg_isready -q -U postgres && break; sleep 1; done
echo "$WORK" > "${TMPDIR:-/tmp}/$P.work"
echo "up.sh: stack up (work dir $WORK)"
