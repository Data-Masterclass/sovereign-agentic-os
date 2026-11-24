#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# conn-key-check.test.sh — scripts/lib/conn-key-check.py against hand-written manifests and a fake kubectl:
#   * render mode: builtin passes without touching the cluster; OS_KEY_PROVIDER=eso needs an
#     ExternalSecret for the key and refuses a chart-rendered key Secret; no os-ui → skip;
#   * live mode (os-ui's verified /api/health `connectionKeys`): builtin + confirmed recovery key passes,
#     unconfirmed / locked / missing FAIL, stackit passes with a note, eso needs a Ready ExternalSecret;
#   * kubectl is never asked for a Secret's data (only `-o name` / ExternalSecrets).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
cat >"$T/bin/kubectl" <<SH
#!/usr/bin/env bash
echo "\$*" >>"$T/calls"
case "\$*" in
  *"get externalsecrets -o json"*) cat "$T/es" 2>/dev/null || echo '{"items":[]}' ;;
  *"get secret os-secrets-encryption-key -o name"*) echo secret/os-secrets-encryption-key ;;
  *) echo "fake kubectl: unexpected \$*" >&2; exit 9 ;;
esac
SH
chmod +x "$T/bin/kubectl"
manifest() { # manifest <OS_KEY_PROVIDER or -> <extra yaml docs…>
  {
    printf 'apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: os-ui}\nspec:\n  template:\n    spec:\n      containers:\n      - name: os-ui\n        env:\n'
    printf '        - {name: OS_SECRETS_NAMESPACE, value: agentic-os-conn-secrets}\n'
    printf '        - name: OS_SECRETS_ENCRYPTION_KEY\n          valueFrom: {secretKeyRef: {name: os-secrets-encryption-key, key: OS_SECRETS_ENCRYPTION_KEY}}\n'
    [ "$1" = - ] || printf '        - {name: OS_KEY_PROVIDER, value: %s}\n' "$1"
    shift
    for d in "$@"; do printf -- '---\n%s\n' "$d"; done
  } >"$T/m.yaml"
}
run() { : >"$T/calls"; out=$(PATH="$T/bin:$PATH" KUBECTL=kubectl NS=agentic-os python3 scripts/lib/conn-key-check.py "$T/m.yaml" "$@" 2>&1); rc=$?; }
KEYSEC='apiVersion: v1
kind: Secret
metadata: {name: os-secrets-encryption-key}
stringData: {OS_SECRETS_ENCRYPTION_KEY: VALUE-MARKER}'
ES='apiVersion: external-secrets.io/v1
kind: ExternalSecret
metadata: {name: os-secrets-encryption-key}
spec: {target: {name: os-secrets-encryption-key}}'

echo "== render mode"
printf 'apiVersion: v1\nkind: ConfigMap\nmetadata: {name: x}\n' >"$T/m.yaml"; run
rc_is "no os-ui → exit 0" 0; check "says skip" "skip" "$out"
manifest - "$KEYSEC"; run
rc_is "builtin (chart-generated master key) passes the render check" 0
check "names the first-boot provider" "builtin" "$out"
[ ! -s "$T/calls" ] && ok "builtin render check needs no cluster call" || bad "builtin render check needs no cluster call" "$(cat "$T/calls")"
manifest eso "$KEYSEC"; run
rc_is "eso + a chart-rendered key Secret → exit 1" 1
check "names the conflict" "rendered by the chart although OS_KEY_PROVIDER=eso" "$out"
absent "no value printed" "VALUE-MARKER" "$out"
manifest eso; run
rc_is "eso without any ExternalSecret → exit 1" 1
check "names the missing ExternalSecret" "written by no ExternalSecret" "$out"
manifest eso "$ES"; run
rc_is "eso + rendered ExternalSecret → exit 0" 0
echo '{"items":[{"metadata":{"name":"os-secrets-encryption-key"},"spec":{"target":{"name":"os-secrets-encryption-key"}}}]}' >"$T/es"
manifest eso; run
rc_is "eso + a live (operator-managed) ExternalSecret → exit 0" 0

echo "== live mode (os-ui's verified verdict from /api/health)"
hc() { printf '{"status":"ok","connectionKeys":{"status":"%s","provider":"%s","recovery":"%s"}}' "$1" "$2" "$3" >"$T/health"; }
manifest - "$KEYSEC"
hc ready builtin confirmed; run --live --health "$T/health"
rc_is "builtin + confirmed recovery key → exit 0" 0
check "reported ok" "confirmed recovery key" "$out"
hc ready builtin unconfirmed; run --live --health "$T/health"
rc_is "builtin WITHOUT a confirmed recovery key → exit 1" 1
check "names why" "WITHOUT a confirmed recovery key" "$out"
hc locked "" missing; run --live --health "$T/health"
rc_is "locked → exit 1" 1; check "says locked" "are locked" "$out"
echo '{"status":"ok"}' >"$T/health"; run --live --health "$T/health"
rc_is "no connectionKeys in /api/health → exit 1 (fail closed)" 1
run --live
rc_is "--live without --health → exit 1" 1
hc ready stackit missing; run --live --health "$T/health"
rc_is "stackit → exit 0" 0
check "a missing recovery key is a note" "note no recovery key" "$out"
manifest eso "$ES"
hc ready eso missing
echo '{"items":[{"metadata":{"name":"os-secrets-encryption-key"},"status":{"conditions":[{"type":"Ready","status":"False"}]}}]}' >"$T/es"; run --live --health "$T/health"
rc_is "eso with a not-Ready ExternalSecret → exit 1" 1
echo '{"items":[{"metadata":{"name":"os-secrets-encryption-key"},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}' >"$T/es"; run --live --health "$T/health"
rc_is "eso with a Ready ExternalSecret → exit 0" 0
manifest - "$KEYSEC"
echo '{"items":[]}' >"$T/es"; run --live --health "$T/health"
rc_is "record says eso but no ExternalSecret writes the key → exit 1" 1
check "names it" "names the eso provider, but no Ready ExternalSecret" "$out"
echo '{"items":[{"metadata":{"name":"os-secrets-encryption-key"},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}' >"$T/es"; run --live --health "$T/health"
rc_is "record says eso and the ExternalSecret is Ready → exit 0" 0
if grep -E 'get secret [a-z-]+ -o (json|yaml)( |$)' "$T/calls" >/dev/null; then bad "no Secret is ever read with its data" "$(cat "$T/calls")"; else ok "no Secret is ever read with its data"; fi

finish conn-key-check
