#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# langfuse-idle-rate.sh [minutes] — post-deploy check for the gateway's span scope (WP-32).
#
# The chart ships LITELLM_OTEL_LANGFUSE_SPAN_SCOPE=llm_only, so this should report ~0. Under `full`
# (only with WP-05's collector filter in front of Langfuse) LiteLLM also exports its own background work
# (database polls, spend writes, cache calls) to Langfuse as traces of their own. They carry no
# tags; every trace the OS or a model call produces carries `domain:`/`tab:` tags. This script
# counts the UNTAGGED traces Langfuse receives in a window (default 10 minutes) and prints the
# rate per second. Read-only: it only calls Langfuse's public read API.
#
# Decision rule (docs/ops/litellm-upgrade.md §1 "Span scope after the deploy"):
#   rate <= 0.2 / s  -> fine (the expected result);
#   rate >  0.2 / s  -> under `full`: back to `llm_only`; under `llm_only`: find the other sender.
#
#   kubectl --context dmagenticos -n agentic-os port-forward svc/agentic-os-langfuse-web 3000:3000 &
#   LANGFUSE_URL=http://127.0.0.1:3000 LANGFUSE_PUBLIC_KEY=… LANGFUSE_SECRET_KEY=… deploy/langfuse-idle-rate.sh 10
# The keys are read into the environment without printing them (e.g. from the langfuse-init Secret).
# Exit 0 = within the threshold, 3 = above it, 2 = could not measure.
set -euo pipefail
MIN=${1:-10}; LF=${LANGFUSE_URL:?LANGFUSE_URL}; : "${LANGFUSE_PUBLIC_KEY:?}" "${LANGFUSE_SECRET_KEY:?}"
THRESHOLD=${THRESHOLD:-0.2}
AUTH="Basic $(printf '%s:%s' "$LANGFUSE_PUBLIC_KEY" "$LANGFUSE_SECRET_KEY" | base64 | tr -d '\n')"
FROM=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "measuring untagged (gateway background) traces from $FROM for $MIN minute(s)…"
python3 -c "import time; time.sleep($MIN*60)"
TO=$(date -u +%Y-%m-%dT%H:%M:%SZ)
python3 - "$LF" "$AUTH" "$FROM" "$TO" "$MIN" "$THRESHOLD" <<'PY'
import json, sys, urllib.request, urllib.parse
lf, auth, frm, to, minutes, thr = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], float(sys.argv[5]), float(sys.argv[6])
untagged = total = 0; page = 1
while True:
    q = urllib.parse.urlencode({'fromTimestamp': frm, 'toTimestamp': to, 'limit': 100, 'page': page})
    req = urllib.request.Request(f'{lf}/api/public/traces?{q}', headers={'Authorization': auth})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=30))
    except Exception as e:
        print(f'could not read Langfuse: {e}'); sys.exit(2)
    rows = d.get('data', [])
    total += len(rows); untagged += sum(1 for t in rows if not t.get('tags'))
    if page >= d.get('meta', {}).get('totalPages', 1) or not rows: break
    page += 1
rate = untagged / (minutes * 60)
print(f'traces in window: {total}; untagged (gateway background): {untagged}; rate {rate:.3f}/s (threshold {thr}/s)')
if rate > thr:
    print('DECISION: above the threshold — under full go back to llm_only; under llm_only find the other untagged sender'); sys.exit(3)
print('DECISION: within the threshold')
PY
