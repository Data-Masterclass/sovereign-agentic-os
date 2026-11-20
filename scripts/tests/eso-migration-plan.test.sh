#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# eso-migration-plan.test.sh — scripts/ops/eso-migration-plan.sh against a fake kubectl:
#   * it only ever runs `kubectl … get secret` (it writes nothing);
#   * no Secret value reaches its output (the fixtures carry recognisable values);
#   * MATCH / ABSENT per Secret, the handover and managed lists, the remote paths;
#   * twins: a live Secret with an extra key, or another type → DIFFERS, exit 1, no steps printed;
#   * --apply / --write / --push are refused.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/fx"
# Fixtures: name -> JSON. VALUE-MARKER-* would show up in the output if a value leaked.
b64() { printf '%s' "$1" | base64; }
fx() { # fx <name> <type> <key>…
  local n=$1 t=$2; shift 2; local d="" k
  for k in "$@"; do d="$d\"$k\":\"$(b64 "VALUE-MARKER-$n-$k")\","; done
  printf '{"type":"%s","metadata":{"name":"%s"},"data":{%s}}' "$t" "$n" "${d%,}" >"$T/fx/$n"
}
fx litellm-credentials Opaque LANGFUSE_HOST LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LITELLM_SALT_KEY STACKIT_API_BASE STACKIT_API_KEY UI_PASSWORD UI_USERNAME masterkey
fx postgres-litellm-credentials kubernetes.io/basic-auth password username
fx ghcr-pull kubernetes.io/dockerconfigjson .dockerconfigjson
cat >"$T/bin/kubectl" <<SH
#!/usr/bin/env bash
echo "\$*" >>"$T/calls"
name=""; prev=""; for a in "\$@"; do [ "\$prev" = secret ] && name=\$a; prev=\$a; done
case " \$* " in *" get secret "*) ;; *) echo "fake kubectl: unexpected call: \$*" >&2; exit 9 ;; esac
[ -f "$T/fx/\$name" ] && cat "$T/fx/\$name" || { echo "Error from server (NotFound)" >&2; exit 1; }
SH
chmod +x "$T/bin/kubectl"
run() { out=$(PATH="$T/bin:$PATH" bash scripts/ops/eso-migration-plan.sh "$@" 2>&1); rc=$?; }

run --context kind-x --instance-id inst-1 --names litellm-credentials,postgres-litellm-credentials,ghcr-pull,valkey-credentials
rc_is "all live Secrets match → exit 0" 0
check "litellm-credentials MATCH" "litellm-credentials                          chart   MATCH" "$out"
check "valkey-credentials ABSENT (not on the fake cluster)" "valkey-credentials                           chart   ABSENT" "$out"
check "remote path is <instance>/data/<namespace>/<name>" "/v1/inst-1/data/agentic-os/litellm-credentials" "$out"
check "dockerconfigjson is written under a plain property" '.key = "dockerconfigjson"' "$out"
check "handover lists the chart Secrets" "externalSecrets.handover: [litellm-credentials,postgres-litellm-credentials]" "$out"
check "managed lists chart + manual" "externalSecrets.managed: [litellm-credentials,postgres-litellm-credentials,ghcr-pull]" "$out"
absent "no value in the output" "VALUE-MARKER" "$out"
absent "no base64 value in the output" "$(b64 VALUE-MARKER-litellm-credentials-masterkey)" "$out"
[ -z "$(grep -v ' get secret ' "$T/calls")" ] && ok "every kubectl call is a get" || bad "every kubectl call is a get" "$(cat "$T/calls")"
check "kubectl uses the given context" "--context kind-x" "$(cat "$T/calls")"

fx postgres-litellm-credentials kubernetes.io/basic-auth password username extra
run --names litellm-credentials,postgres-litellm-credentials
rc_is "twin: an extra live key → exit 1" 1
check "twin: reported as DIFFERS" "chart   DIFFERS  live [kubernetes.io/basic-auth extra,password,username]" "$(grep "^postgres-litellm-credentials " <<<"$out")"
absent "twin: no copy step printed" "curl -sS" "$out"
fx postgres-litellm-credentials Opaque password username
run --names postgres-litellm-credentials
rc_is "twin: another type → exit 1" 1
check "twin: the refusal names the catalog" "REFUSED" "$out"
absent "twin: no value in the refusal" "VALUE-MARKER" "$out"

for f in --apply --write --push; do run "$f"; rc_is "$f is refused" 2; check "$f refusal says dry-run" "dry-run only" "$out"; done
run --names no-such-secret
rc_is "an unknown name fails" 1

finish eso-migration-plan
