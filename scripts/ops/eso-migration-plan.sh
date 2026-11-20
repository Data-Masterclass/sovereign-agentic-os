#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# eso-migration-plan.sh — WP-10 DRY-RUN plan for moving each live platform Secret into STACKIT
# Secrets Manager and handing it to External Secrets. It WRITES NOTHING: one `kubectl get secret`
# per catalog entry (key NAMES and type only, never a value), then the plan is printed.
# Run-book: docs/ops/external-secrets-migration.md.
# =============================================================================
#   scripts/ops/eso-migration-plan.sh [--context dmagenticos] [--namespace agentic-os]
#                                     [--instance-id <id>] [--prefix <remote prefix>] [--names a,b]
#   scripts/ops/eso-migration-plan.sh --compare-backend --instance-id <id> [same options]
#       (Step D gate, read-only) every MATCH Secret's live values = its Secrets Manager copy, by
#       sha256 per key, read with the READER token from the mode-600 header file $SM_HEADER.
#
# Per Secret: MATCH (live name, type and keys = the catalog: ESO will write the same Secret),
# DIFFERS (fix the catalog first — the plan refuses), EMPTY (a key holds an empty or whitespace-only
# value: ESO refuses
# them, so the Secret is not moved until it has one), ABSENT (nothing to move). Exit 0 when
# no live Secret differs, 1 when one does, 2 on a usage error. --apply does not exist.
set -euo pipefail
CTX=dmagenticos NS=agentic-os INSTANCE="<instance-id>" PREFIX="" NAMES="" COMPARE=""
while [ $# -gt 0 ]; do
  case $1 in
    --context) CTX=$2; shift ;;
    --namespace) NS=$2; shift ;;
    --instance-id) INSTANCE=$2; shift ;;
    --prefix) PREFIX=$2; shift ;;
    --names) NAMES=$2; shift ;;
    --compare-backend) COMPARE=1 ;;
    --apply|--write|--push) echo "eso-migration-plan: dry-run only — $1 does not exist; the owner runs the printed steps (docs/ops/external-secrets-migration.md)" >&2; exit 2 ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
PREFIX=${PREFIX:-$NS}
REPO=$(cd "$(dirname "$0")/../.." && pwd)
CATALOG=$REPO/charts/sovereign-agentic-os/files/external-secrets/catalog.yaml
SM=https://prod.sm.eu01.stackit.cloud

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
python3 - "$CATALOG" "$NAMES" >"$TMP/entries" <<'PY'
import sys, yaml
cat = yaml.safe_load(open(sys.argv[1]))["secrets"]
want = [n for n in sys.argv[2].split(",") if n] or list(cat)
for n in want:
    if n not in cat: sys.exit(f"{n}: not in the catalog")
    e = cat[n]; rp = e.get("remoteProperty") or {}
    print(n, e["source"], e["type"], ",".join(sorted(e["keys"])), ",".join(f"{k}={v}" for k, v in rp.items()) or "-")
PY

printf 'WP-10 migration plan (DRY RUN — nothing was written)\n'
printf 'cluster context %s, namespace %s → Secrets Manager %s, KV v2 mount %s, prefix %s/\n\n' "$CTX" "$NS" "$SM" "$INSTANCE" "$PREFIX"
printf '%-44s %-7s %-8s %s\n' SECRET SOURCE STATUS "KEYS (names only)"
differs=0; chart="" manual=""
while read -r name source type keys rp; do
  # Names and type only: jq never sees a value outside .data|keys.
  # Type, key names and which keys are EMPTY (a length test inside python; no value leaves it).
  live="" empty=""
  read -r live empty < <(kubectl --context "$CTX" -n "$NS" get secret "$name" -o json 2>/dev/null \
    | python3 -c 'import json,sys,base64; d=json.load(sys.stdin); v=d.get("data") or {}
print((d.get("type") or "Opaque") + "|" + ",".join(sorted(v)), ",".join(k for k in sorted(v) if not base64.b64decode(v[k]).strip()) or "-")' 2>/dev/null || true) || true
  live=${live/|/ }
  if [ -z "$live" ]; then status=ABSENT detail="not on the cluster — nothing to move"
  elif [ "$live" = "$type $keys" ] && [ "${empty:--}" != "-" ]; then status=EMPTY detail="empty value in: $empty — not moved (ESO refuses empty values)"
  elif [ "$live" = "$type $keys" ]; then status=MATCH detail="$type: $keys"
    if [ "$source" = chart ]; then chart="$chart,$name"; else manual="$manual,$name"; fi
  else status=DIFFERS detail="live [$live] vs catalog [$type $keys]"; differs=1; fi
  printf '%-44s %-7s %-8s %s\n' "$name" "$source" "$status" "$detail"
  [ "$status" = MATCH ] && printf '%s %s\n' "$name" "$rp" >>"$TMP/move"
done <"$TMP/entries"
chart=${chart#,} manual=${manual#,}

if [ -n "$COMPARE" ]; then
  [ "$INSTANCE" != "<instance-id>" ] || { echo "--compare-backend needs --instance-id" >&2; exit 2; }
  [ -n "${SM_HEADER:-}" ] && [ -r "$SM_HEADER" ] || { echo "--compare-backend needs SM_HEADER: a mode-600 file holding 'X-Vault-Token: <reader token>'" >&2; exit 2; }
  printf '\nStep D gate — live vs Secrets Manager (sha256 per key; no value is printed)\n'
  [ -f "$TMP/move" ] || { echo "nothing to compare"; exit 0; }
  CTX=$CTX NS=$NS SM=$SM INSTANCE=$INSTANCE PREFIX=$PREFIX python3 - "$TMP/move" <<'PY'
import base64, hashlib, json, os, subprocess, sys
h = lambda b: hashlib.sha256(b).hexdigest()
bad = 0
for line in open(sys.argv[1]):
    name, rp = line.split()
    ren = dict(p.split("=", 1) for p in rp.split(",")) if rp != "-" else {}
    live = json.loads(subprocess.run(["kubectl", "--context", os.environ["CTX"], "-n", os.environ["NS"], "get", "secret", name, "-o", "json"],
                                     capture_output=True, check=True).stdout).get("data") or {}
    url = f'{os.environ["SM"]}/v1/{os.environ["INSTANCE"]}/data/{os.environ["PREFIX"]}/{name}'
    r = subprocess.run(["curl", "-sS", "--fail", "-H", "@" + os.environ["SM_HEADER"], url], capture_output=True)
    if r.returncode != 0:
        print(f"  {name:44s} MISSING  not readable in Secrets Manager"); bad = 1; continue
    remote = (json.loads(r.stdout).get("data") or {}).get("data") or {}
    diff = [k for k, v in sorted(live.items()) if h(base64.b64decode(v)) != h(str(remote.get(ren.get(k, k), "\0")).encode())]
    if diff: print(f"  {name:44s} DIFFERS  keys: {','.join(diff)}"); bad = 1
    else: print(f"  {name:44s} SAME")
if bad: print("\nREFUSED: Secrets Manager is not a copy of the live Secrets; re-run Step B for those, then compare again.")
sys.exit(bad)
PY
  exit $?
fi

if [ "$differs" -ne 0 ]; then
  printf '\nREFUSED: a live Secret differs from the catalog. ESO would write a different Secret; fix\n'
  printf 'charts/sovereign-agentic-os/files/external-secrets/catalog.yaml first.\n'
  exit 1
fi

cat <<PLAN

Step A — owner prerequisites (once): docs/ops/external-secrets-migration.md §1 (instance, two
users, ACL, the ESO bootstrap Secret, deploy/external-secrets/install.sh).

Step B — copy each MATCH Secret into Secrets Manager (run by the owner; values travel on stdin,
the writer token is read from a mode-600 header file \$SM_HEADER = "X-Vault-Token: <token>").
For every Secret below, ONE write of all its keys to $INSTANCE/data/$PREFIX/<name>:
PLAN
while read -r name rp; do
  rename=""
  if [ "$rp" != "-" ]; then
    for pair in ${rp//,/ }; do rename="$rename | with_entries(if .key == \"${pair%%=*}\" then .key = \"${pair#*=}\" else . end)"; done
  fi
  printf "  kubectl --context %s -n %s get secret %s -o json | jq -c '{data: (.data | map_values(@base64d)%s)}' \\\\\n" "$CTX" "$NS" "$name" "$rename"
  printf "    | curl -sS --fail -H @\"\$SM_HEADER\" -H 'Content-Type: application/json' --data-binary @- %s/v1/%s/data/%s/%s >/dev/null\n" "$SM" "$INSTANCE" "$PREFIX" "$name"
done <"$TMP/move"
cat <<PLAN

Step C — handover release (chart Secrets only; no data change, no pod restart):
  externalSecrets.handover: [${chart}]
  then: helm get manifest shows helm.sh/resource-policy: keep on each of them.

Step D — switch to ESO (one release; Helm keeps the Secrets, ESO takes them over in place):
  externalSecrets.enabled: true
  externalSecrets.store.instanceId: $INSTANCE
  externalSecrets.store.username: <read-only user>
  externalSecrets.managed: [${chart}${chart:+${manual:+,}}${manual}]

  Before this release: scripts/ops/eso-migration-plan.sh --compare-backend --instance-id $INSTANCE
  must print SAME for every Secret (a value rotated after Step B would otherwise be replaced).

Step E — verify (read-only):
  kubectl --context $CTX -n $NS get externalsecrets           # every one Ready=True / SecretSynced
  kubectl --context $CTX get clustersecretstore stackit-secrets-manager   # Ready=True
  scripts/ops/eso-migration-plan.sh --context $CTX              # every Secret still MATCH
  scripts/ops/rotate-secrets.sh verify --overlay <last overlay> --context $CTX

Rollback: remove the names from externalSecrets.managed (and enabled: false). ESO's creationPolicy
is Orphan, so deleting an ExternalSecret leaves its Secret as it is; the chart renders it again.
PLAN
