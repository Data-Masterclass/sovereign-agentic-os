#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# external-secrets.kind.sh — WP-10 against the REAL External Secrets Operator (pinned 2.15.0,
# installed by deploy/external-secrets/install.sh) on kind. No OS component runs: only upstream ESO
# and the manifests `helm template` renders from this chart (the eject test).
# =============================================================================
#   bash scripts/tests/external-secrets.kind.sh      (needs docker, kind, kubectl, helm, python3)
#   ESO_KIND_KUBECONFIG=<file> ESO_KIND_NAME=<name>  reuse an existing kind cluster (not deleted)
#
# The backend is ESO's fake provider (CI has no STACKIT Secrets Manager); it serves one JSON
# document per remote key, like a KV v2 secret with one property per key. Proves:
#   1. the chart's STACKIT ClusterSecretStore (vault provider, KV v2, userPass) is accepted by ESO's
#      admission webhook and ESO itself tries it: with no reachable server it reports Ready=False;
#   2. handover: Secrets rendered by the chart (the live shape, with helm.sh/resource-policy: keep)
#      and a hand-made dockerconfigjson Secret are TAKEN OVER in place by the ExternalSecrets the
#      chart renders — same name, same type, same key set; the values are now the backend's;
#      ESO stamps them (data-hash, managed label) and sets no owner reference (Orphan);
#   3. rotation: a new backend value reaches the Secret on a force-sync, the other keys unchanged;
#   4. negative twin: a backend entry missing a key → the ExternalSecret is NOT Ready and the
#      existing Secret keeps its value (no outage, no partial Secret);
#   5. negative twin: the "synced by ESO" assertion FAILS on a Secret written by kubectl alone;
#   6. rollback: deleting an ExternalSecret leaves its Secret in place, unchanged.
# Values are random per run, compared by sha256, never printed. Own kubeconfig: never touches
# ~/.kube/config.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
for b in docker kind kubectl helm python3 openssl; do command -v "$b" >/dev/null || { echo "$b not on PATH"; exit 2; }; done
ls charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1 || { echo "no subchart .tgz (helm dependency build charts/sovereign-agentic-os)"; exit 2; }
NAME=${ESO_KIND_NAME:-wp10-eso}
TMP=$(mktemp -d); chmod 700 "$TMP"
if [ -n "${ESO_KIND_KUBECONFIG:-}" ]; then
  export KUBECONFIG=$ESO_KIND_KUBECONFIG; OWN=""
else
  export KUBECONFIG=$TMP/kubeconfig; OWN=1
  kind create cluster --name "$NAME" --kubeconfig "$KUBECONFIG" --wait 120s >/dev/null 2>&1 || { echo "kind create failed"; exit 2; }
fi
CTX=kind-$NAME NS=agentic-os
K() { kubectl --context "$CTX" "$@"; }
cleanup() {
  if [ -n "$OWN" ]; then kind delete cluster --name "$NAME" --kubeconfig "$KUBECONFIG" >/dev/null 2>&1
  else K delete ns "$NS" --wait=false >/dev/null 2>&1; K delete clustersecretstore stackit-secrets-manager >/dev/null 2>&1; fi
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "== install the pinned upstream operator"
bash deploy/external-secrets/install.sh --context "$CTX" >"$TMP/install.log" 2>&1 || { tail -20 "$TMP/install.log"; exit 2; }
ok "external-secrets $(K -n external-secrets get deploy external-secrets -o jsonpath='{.spec.template.spec.containers[0].image}' | sed 's/@.*//') Available"
K wait --for=delete "ns/$NS" --timeout=120s >/dev/null 2>&1 || true
K create ns "$NS" >/dev/null || { echo "namespace $NS"; exit 2; }
K -n external-secrets create secret generic stackit-secrets-manager-eso --from-literal=password="$(openssl rand -hex 16)" >/dev/null 2>&1 || true

OPT=(--set osUI.graph.enabled=true --set osUI.smtp.enabled=true --set serviceBearer.enabled=true
     --set postgres.governance.enabled=true --set postgres.governance.adminSecretName=pg-admin)
CHART_NAMES="litellm-credentials,postgres-litellm-credentials,langfuse-core-secrets,os-ui-session,valkey-credentials"
MANUAL_NAMES="ghcr-pull"
render() { helm template agentic-os charts/sovereign-agentic-os -n "$NS" --skip-schema-validation "$@" 2>/dev/null; }
# only <kinds> <names> — keep the named docs of those kinds from a render on stdin
only() { python3 -c '
import sys, yaml
kinds, names = sys.argv[1].split(","), sys.argv[2].split(",")
docs = [d for d in yaml.safe_load_all(sys.stdin) if isinstance(d, dict) and d.get("kind") in kinds and (names == ["*"] or d["metadata"]["name"] in names)]
print(yaml.safe_dump_all(docs))' "$1" "$2"; }
# shape <name> — "type key1,key2,…" of a live Secret (names only)
shape() { K -n "$NS" get secret "$1" -o json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d.get("type"), ",".join(sorted(d.get("data") or {})))'; }
# hashes <name> — "key=sha256[:16]" per key of a live Secret, values never printed
hashes() { K -n "$NS" get secret "$1" -o json | python3 -c '
import json, sys, base64, hashlib
d = json.load(sys.stdin).get("data") or {}
print(" ".join(f"{k}={hashlib.sha256(base64.b64decode(v)).hexdigest()[:16]}" for k, v in sorted(d.items())))'; }

echo "== 1. the STACKIT ClusterSecretStore, as the chart renders it, against the real operator"
render --set externalSecrets.enabled=true --set externalSecrets.store.instanceId=wp10-test-instance \
  --set externalSecrets.store.username=eso-reader --set externalSecrets.store.server=https://127.0.0.1:9 \
  | only ClusterSecretStore '*' >"$TMP/store.yaml"
out=$(K apply -f "$TMP/store.yaml" 2>&1); rc=$?
rc_is "admission webhook accepts the vault/userPass store" 0
st=""; for _ in $(seq 1 30); do
  st=$(K get clustersecretstore stackit-secrets-manager -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}/{.status.conditions[?(@.type=="Ready")].reason}' 2>/dev/null)
  [ -n "${st%/}" ] && [ "$st" != "/" ] && break; sleep 2
done
check "ESO tried the vault provider and reports it not Ready (no server)" "False/" "$st"
K delete -f "$TMP/store.yaml" >/dev/null

echo "== 2. the live shape: chart-rendered Secrets in handover + one hand-made Secret"
# litellmSaltKey set: live litellm-credentials carries LITELLM_SALT_KEY (rotation 2026-11).
render "${OPT[@]}" --set litellmSaltKey.value="$(openssl rand -hex 16)" --set "externalSecrets.handover={$CHART_NAMES}" | only Secret "$CHART_NAMES" >"$TMP/live.yaml"
K -n "$NS" apply -f "$TMP/live.yaml" >/dev/null || { echo "apply live Secrets failed"; exit 2; }
printf '{"auths":{"registry.example":{"auth":"%s"}}}' "$(openssl rand -hex 12)" >"$TMP/dcj.json"
K -n "$NS" create secret generic ghcr-pull --type=kubernetes.io/dockerconfigjson --from-file=.dockerconfigjson="$TMP/dcj.json" >/dev/null
check "handover Secret carries helm.sh/resource-policy: keep" "keep" "$(K -n "$NS" get secret litellm-credentials -o jsonpath='{.metadata.annotations.helm\.sh/resource-policy}')"
for n in ${CHART_NAMES//,/ } $MANUAL_NAMES; do shape "$n" >"$TMP/before.$n"; hashes "$n" >"$TMP/before-h.$n"; done

# The backend: a fake ClusterSecretStore under the chart's store name, one JSON document per
# remote key agentic-os/<name>, NEW random values for exactly the live keys (valkey-credentials is
# deliberately left without its key: twin 4).
python3 - "$TMP" "$CHART_NAMES,$MANUAL_NAMES" <<'PY'
import json, os, secrets, sys, yaml, hashlib
tmp, names = sys.argv[1], sys.argv[2].split(",")
cat = yaml.safe_load(open("charts/sovereign-agentic-os/files/external-secrets/catalog.yaml"))["secrets"]
data, expect = [], {}
for n in names:
    e = cat[n]; rp = e.get("remoteProperty") or {}
    doc = {}
    for k in e["keys"]:
        if n == "valkey-credentials": continue
        v = json.dumps({"auths": {"r.example": {"auth": secrets.token_hex(8)}}}) if k == ".dockerconfigjson" else secrets.token_hex(16)
        doc[rp.get(k, k)] = v
        expect.setdefault(n, {})[k] = hashlib.sha256(v.encode()).hexdigest()[:16]
    data.append({"key": f"agentic-os/{n}", "value": json.dumps(doc)})
store = {"apiVersion": "external-secrets.io/v1", "kind": "ClusterSecretStore",
         "metadata": {"name": "stackit-secrets-manager"},
         "spec": {"provider": {"fake": {"data": data}}}}
fd = os.open(f"{tmp}/fake-store.yaml", os.O_WRONLY | os.O_CREAT, 0o600); os.write(fd, yaml.safe_dump(store).encode()); os.close(fd)
json.dump(expect, open(f"{tmp}/expect.json", "w"))
PY
K apply -f "$TMP/fake-store.yaml" >/dev/null 2>&1 || { echo "fake store apply failed"; exit 2; }
render --set externalSecrets.enabled=true --set externalSecrets.store.create=false \
  --set "externalSecrets.managed={$CHART_NAMES,$MANUAL_NAMES}" | only ExternalSecret '*' >"$TMP/es.yaml"
out=$(K -n "$NS" apply -f "$TMP/es.yaml" 2>&1); rc=$?
rc_is "the chart's ExternalSecrets are accepted" 0

# eso_synced <name> — the Secret was written by ESO from the backend: its ExternalSecret is Ready,
# ESO's data-hash annotation and managed label are on it, it has no owner reference (Orphan), and
# every key's value is the backend's.
eso_synced() {
  local n=$1 r
  [ "$(K -n "$NS" get externalsecret "$n" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}' 2>/dev/null)" = True ] || { echo "ExternalSecret $n not Ready"; return 1; }
  r=$(K -n "$NS" get secret "$n" -o json | python3 -c '
import json, sys, base64, hashlib
s = json.load(sys.stdin); n = sys.argv[1]; exp = json.load(open(sys.argv[2])).get(n, {})
m = s["metadata"]
if not (m.get("annotations") or {}).get("reconcile.external-secrets.io/data-hash"): print("no ESO data-hash"); sys.exit()
if (m.get("labels") or {}).get("reconcile.external-secrets.io/managed") != "true": print("no ESO managed label"); sys.exit()
if m.get("ownerReferences"): print("has an owner reference"); sys.exit()
got = {k: hashlib.sha256(base64.b64decode(v)).hexdigest()[:16] for k, v in (s.get("data") or {}).items()}
print("OK" if got == exp else "values are not the backend values")' "$n" "$TMP/expect.json")
  [ "$r" = OK ] || { echo "$n: $r"; return 1; }
}
for n in ${CHART_NAMES//,/ } $MANUAL_NAMES; do
  [ "$n" = valkey-credentials ] && continue
  K -n "$NS" wait externalsecret "$n" --for=condition=Ready --timeout=90s >/dev/null 2>&1
  holds "$n: taken over and synced by ESO from the backend" eso_synced "$n"
  check "$n: same type and keys as before" "$(cat "$TMP/before.$n")" "$(shape "$n")"
done
check "the dockerconfigjson Secret keeps its type" "kubernetes.io/dockerconfigjson .dockerconfigjson" "$(shape ghcr-pull)"

echo "== 3. rotation: a new backend value reaches the Secret"
python3 - "$TMP" <<'PY'
import json, secrets, sys, yaml, hashlib, os
tmp = sys.argv[1]; p = f"{tmp}/fake-store.yaml"; st = yaml.safe_load(open(p)); exp = json.load(open(f"{tmp}/expect.json"))
for d in st["spec"]["provider"]["fake"]["data"]:
    if d["key"] == "agentic-os/litellm-credentials":
        doc = json.loads(d["value"]); v = secrets.token_hex(16); doc["masterkey"] = v; d["value"] = json.dumps(doc)
        exp["litellm-credentials"]["masterkey"] = hashlib.sha256(v.encode()).hexdigest()[:16]
open(p, "w").write(yaml.safe_dump(st)); json.dump(exp, open(f"{tmp}/expect.json", "w"))
PY
K apply -f "$TMP/fake-store.yaml" >/dev/null 2>&1
K -n "$NS" annotate externalsecret litellm-credentials force-sync="$(date +%s)" --overwrite >/dev/null
r=""; for _ in $(seq 1 30); do eso_synced litellm-credentials >/dev/null 2>&1 && { r=OK; break; }; sleep 2; done
check "litellm-credentials/masterkey rotated from the backend; other keys still the backend's" "OK" "$r"

echo "== 4. negative twin: a backend entry without the key"
st=$(K -n "$NS" get externalsecret valkey-credentials -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}/{.status.conditions[?(@.type=="Ready")].reason}')
check "valkey-credentials ExternalSecret is not Ready" "False/SecretSyncedError" "$st"
check "the existing valkey-credentials Secret keeps its value" "$(cat "$TMP/before-h.valkey-credentials")" "$(hashes valkey-credentials)"
if eso_synced valkey-credentials >/dev/null 2>&1; then bad "twin: eso_synced must fail for valkey-credentials"; else ok "twin: eso_synced fails for valkey-credentials"; fi

echo "== 5. negative twin: a Secret written without ESO"
K -n "$NS" create secret generic fake-hop --from-literal=token="$(openssl rand -hex 8)" >/dev/null
if eso_synced fake-hop >/dev/null 2>&1; then bad "twin: eso_synced must fail on a kubectl-made Secret"; else ok "twin: eso_synced fails on a kubectl-made Secret"; fi

echo "== 6. rollback: delete the ExternalSecret, the Secret stays"
h=$(hashes os-ui-session)
K -n "$NS" delete externalsecret os-ui-session --wait=true >/dev/null
sleep 5
check "os-ui-session still exists, unchanged" "$h" "$(hashes os-ui-session 2>&1)"

finish external-secrets-kind
