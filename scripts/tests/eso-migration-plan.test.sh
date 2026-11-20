#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# eso-migration-plan.test.sh — scripts/ops/eso-migration-plan.sh against a fake kubectl:
#   * it only ever runs `kubectl … get secret` (it writes nothing);
#   * no Secret value reaches its output (the fixtures carry recognisable values);
#   * MATCH / ABSENT per Secret, the handover and managed lists, the remote paths;
#   * twins: a live Secret with an extra key, or another type → DIFFERS, exit 1, no steps printed;
#   * EMPTY: a key with an empty value is reported and its Secret is not moved;
#   * --compare-backend (the Step D gate): SAME / DIFFERS / MISSING by hash, curl only reads, no value;
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

# EMPTY: a key with an empty live value is reported and not moved.
fx postgres-litellm-credentials kubernetes.io/basic-auth password username
printf '{"type":"Opaque","metadata":{"name":"os-ui-smtp"},"data":{"SMTP_PASS":""}}' >"$T/fx/os-ui-smtp"
run --names os-ui-smtp,postgres-litellm-credentials
rc_is "an EMPTY Secret is not an error" 0
check "os-ui-smtp reported EMPTY" "EMPTY    empty value in: SMTP_PASS" "$out"
absent "os-ui-smtp gets no copy step" "get secret os-ui-smtp" "$out"
check "os-ui-smtp is not in the managed list" "externalSecrets.managed: [postgres-litellm-credentials]" "$out"

# --compare-backend (Step D gate): fake curl serves a KV v2 read; values compared by hash only.
cat >"$T/bin/curl" <<SH
#!/usr/bin/env bash
echo "\$*" >>"$T/curl-calls"
url=\${@: -1}; name=\${url##*/}
[ -f "$T/sm/\$name" ] && cat "$T/sm/\$name" || exit 22
SH
chmod +x "$T/bin/curl"; mkdir -p "$T/sm"
printf 'X-Vault-Token: fake\n' >"$T/hdr"; chmod 600 "$T/hdr"
printf '{"data":{"data":{"password":"VALUE-MARKER-postgres-litellm-credentials-password","username":"VALUE-MARKER-postgres-litellm-credentials-username"}}}' >"$T/sm/postgres-litellm-credentials"
printf '{"data":{"data":{"dockerconfigjson":"VALUE-MARKER-ghcr-pull-.dockerconfigjson"}}}' >"$T/sm/ghcr-pull"
cmp() { out=$(SM_HEADER="$T/hdr" PATH="$T/bin:$PATH" bash scripts/ops/eso-migration-plan.sh --compare-backend --instance-id inst-1 "$@" 2>&1); rc=$?; }
cmp --names postgres-litellm-credentials,ghcr-pull
rc_is "compare: backend = live → exit 0" 0
check "compare: SAME (dockerconfigjson via its remote property)" "ghcr-pull                                    SAME" "$out"
absent "compare: no value printed" "VALUE-MARKER" "$out"
absent "compare: no copy step in this mode" "curl -sS --fail -H @" "$out"
grep -qE -- '-X|--data|POST' "$T/curl-calls" && bad "compare: curl only reads" "$(cat "$T/curl-calls")" || ok "compare: curl only reads"
grep -q -- "-H @$T/hdr" "$T/curl-calls" && ok "compare: the token comes from the header file" || bad "compare: the token comes from the header file"
printf '{"data":{"data":{"password":"older","username":"VALUE-MARKER-postgres-litellm-credentials-username"}}}' >"$T/sm/postgres-litellm-credentials"
cmp --names postgres-litellm-credentials
rc_is "twin: a value rotated after the copy → exit 1" 1
check "twin: DIFFERS names the key only" "DIFFERS  keys: password" "$out"
absent "twin: no value printed" "older" "$out"
rm "$T/sm/postgres-litellm-credentials"
cmp --names postgres-litellm-credentials
rc_is "twin: not in Secrets Manager → exit 1" 1; check "twin: MISSING" "MISSING" "$out"
out=$(PATH="$T/bin:$PATH" bash scripts/ops/eso-migration-plan.sh --compare-backend --instance-id inst-1 2>&1); rc=$?
rc_is "compare without SM_HEADER is a usage error" 2

for f in --apply --write --push; do run "$f"; rc_is "$f is refused" 2; check "$f refusal says dry-run" "dry-run only" "$out"; done
run --names no-such-secret
rc_is "an unknown name fails" 1

finish eso-migration-plan
