#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# WP-21 harness: the REAL OpenSearch image we ship (images/extensions/opensearch), a REAL S3
# store (SeaweedFS, Apache-2.0) and the chart's own egress proxy (images/base/egress-proxy),
# wired like the cluster: OpenSearch sits on an INTERNAL network with no route to the store;
# only the proxy joins both. The store answers under the STACKIT host name (network alias), so
# the overlay's endpoint and allowlist are used unchanged.
#
#   bash tests/opensearch/up.sh      # build + start (idempotent: removes an old stack first)
#   bash tests/opensearch/down.sh
#
# Config comes from render.py (the chart + the STACKIT overlay). The S3 key pair is generated
# per run and exists only in this throwaway stack.
set -euo pipefail
cd "$(dirname "$0")/../.."
P=${SOA_IT_PREFIX:-soa-it}
WORK=${SOA_IT_WORK:-$(mktemp -d)}
SEAWEED=chrislusf/seaweedfs:4.52@sha256:57877e32bb90073b37dc109b438ba66e84fd5ed9ced5f5c04f56444ef243ce59
CURL=curlimages/curl:8.8.0
S3HOST=object.storage.eu01.onstackit.cloud
BUCKET=soa-ci-snapshots

bash tests/opensearch/down.sh >/dev/null 2>&1 || true
python3 tests/opensearch/render.py "$WORK/render"
chmod -R a+rX "$WORK"

docker build -q -t soa-opensearch:wp21 images/extensions/opensearch >/dev/null
docker build -q -t soa-egress-proxy:wp21 images/base/egress-proxy >/dev/null

docker network create --internal "$P-os" >/dev/null
docker network create "$P-s3" >/dev/null

AK=ci$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
SK=$(od -An -N20 -tx1 /dev/urandom | tr -d ' \n')
mkdir -p "$WORK/seaweed"
cat > "$WORK/seaweed/s3.json" <<JSON
{"identities":[{"name":"opensearch","credentials":[{"accessKey":"$AK","secretKey":"$SK"}],"actions":["Admin","Read","Write","List","Tagging"]}]}
JSON
chmod a+r "$WORK/seaweed/s3.json"
docker run -d --name "$P-s3store" --network "$P-s3" --network-alias "$S3HOST" \
  -v "$WORK/seaweed/s3.json:/etc/seaweedfs/s3.json:ro" \
  "$SEAWEED" server -dir=/data -s3 -s3.port=80 -s3.config=/etc/seaweedfs/s3.json -master.volumeSizeLimitMB=64 >/dev/null

docker run -d --name "$P-proxy" --network "$P-os" --network-alias egress-proxy \
  -v "$WORK/render/proxy:/etc/tinyproxy:ro" soa-egress-proxy:wp21 >/dev/null
docker network connect "$P-s3" "$P-proxy"

# The subchart's keystore initContainer runs `opensearch-keystore add-file <key> <file>` for each
# Secret key; this does the same with the two keys the overlay documents.
mkdir -p "$WORK/keystore" && printf '%s' "$AK" > "$WORK/keystore/s3.client.default.access_key" \
  && printf '%s' "$SK" > "$WORK/keystore/s3.client.default.secret_key" && chmod -R a+rX "$WORK/keystore"
docker run -d --name "$P-opensearch" --network "$P-os" --network-alias opensearch \
  --env-file "$WORK/render/env/opensearch.env" -e discovery.type=single-node -e OPENSEARCH_JAVA_OPTS="-Xms512m -Xmx512m" \
  -v "$WORK/render/opensearch.yml:/usr/share/opensearch/config/opensearch.yml:ro" \
  -v "$WORK/keystore:/tmp/keystoreSecrets/s3:ro" \
  --entrypoint bash soa-opensearch:wp21 -c '
    set -e
    bin/opensearch-keystore create
    for f in /tmp/keystoreSecrets/*/*; do bin/opensearch-keystore add-file "$(basename "$f")" "$f"; done
    mkdir -p /usr/share/opensearch/snapshots
    exec ./opensearch-docker-entrypoint.sh opensearch' >/dev/null

# The bucket (the owner creates it on STACKIT; the repository never creates buckets).
for i in $(seq 1 60); do
  docker exec "$P-s3store" sh -c "echo 's3.bucket.create -name $BUCKET' | weed shell" >/dev/null 2>&1 || true
  docker exec "$P-s3store" sh -c "echo 's3.bucket.list' | weed shell" 2>/dev/null | grep -q "$BUCKET" && break
  sleep 2
done
docker exec "$P-s3store" sh -c "echo 's3.bucket.list' | weed shell" | grep -q "$BUCKET" || { echo "up.sh: bucket not created"; exit 1; }

for i in $(seq 1 90); do
  docker run --rm --network "$P-os" "$CURL" -sf 'http://opensearch:9200/_cluster/health?wait_for_status=yellow&timeout=2s' >/dev/null 2>&1 && break
  [ "$i" = 90 ] && { docker logs --tail 50 "$P-opensearch"; echo "up.sh: OpenSearch did not start"; exit 1; }
  sleep 3
done
echo "$WORK" > "${TMPDIR:-/tmp}/$P.work"
echo "up.sh: stack up (work dir $WORK)"
