#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
# =============================================================================
# mapped-columns.sh — how many stored datasets carry a MAPPED column name (a column whose recorded
# source header differs from its physical name, e.g. order_date <- "Order Date")?
# =============================================================================
#   scripts/lib/mapped-columns.sh --context <ctx> [--ns agentic-os] [--index os-datasets]
#
# READ-ONLY: a port-forward to the in-cluster OpenSearch and paged POST _search (search_after);
# nothing is written and no record content is printed. Prints one integer. Exit non-zero when the
# answer cannot be read — callers treat that as "unknown", never as zero.
set -euo pipefail
CTX='' NS=agentic-os INDEX=${DATASETS_INDEX:-os-datasets}
while [ $# -gt 0 ]; do
  case $1 in
    --context) CTX=${2:-}; shift ;;
    --ns)      NS=${2:-}; shift ;;
    --index)   INDEX=${2:-}; shift ;;
    *) echo "mapped-columns.sh: unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$CTX" ] || { echo "mapped-columns.sh: --context is required" >&2; exit 2; }
PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
kubectl --context "$CTX" -n "$NS" port-forward svc/opensearch "$PORT:9200" >/dev/null 2>&1 &
PF=$!
trap 'kill $PF 2>/dev/null || true' EXIT
for _ in $(seq 1 30); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null 2>&1 && break; sleep 1; done
python3 - "http://127.0.0.1:$PORT/$INDEX/_search" <<'PY'
import json, sys, urllib.request, yaml
url, after, n = sys.argv[1], None, 0
while True:
    body = {"size": 100, "sort": [{"_id": "asc"}], "query": {"match_all": {}}, "_source": ["yaml"]}
    if after: body["search_after"] = after
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    hits = json.load(urllib.request.urlopen(req, timeout=30))["hits"]["hits"]
    if not hits: break
    for h in hits:
        d = yaml.safe_load((h.get("_source") or {}).get("yaml") or "") or {}
        cols = d.get("columns") or []
        if any(isinstance(c, dict) and c.get("source") and c.get("source") != c.get("name") for c in cols): n += 1
    after = hits[-1]["sort"]
print(n)
PY
