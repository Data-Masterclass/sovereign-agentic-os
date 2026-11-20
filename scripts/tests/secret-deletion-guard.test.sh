#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# secret-deletion-guard.test.sh — scripts/lib/secret-deletion-guard.sh (called by deploy.sh) against
# a fake kubectl: a Secret that the next render drops is refused unless the LIVE object carries
# helm.sh/resource-policy: keep; a dropped Secret that is already gone (explicit NotFound) passes;
# FAIL CLOSED: any kubectl error refuses; no other object
# kind is touched; only `get secret` is ever run. The real-Helm proof: external-secrets.kind.sh §7.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/live"
cat >"$T/bin/kubectl" <<SH
#!/usr/bin/env bash
echo "\$*" >>"$T/calls"
case " \$* " in *" get secret "*) ;; *) exit 9 ;; esac
[ -n "\${FAKE_KUBECTL_FAIL:-}" ] && { echo "Unable to connect to the server" >&2; exit 1; }
name=""; prev=""; for a in "\$@"; do [ "\$prev" = secret ] && name=\$a; prev=\$a; done
if [ ! -f "$T/live/\$name" ]; then
  case " \$* " in *" --ignore-not-found "*) exit 0 ;; *) echo "NotFound" >&2; exit 1 ;; esac
fi
printf '%s|%s' "\$name" "\$(cat "$T/live/\$name")"
SH
chmod +x "$T/bin/kubectl"
doc() { printf -- '---\napiVersion: v1\nkind: %s\nmetadata:\n  name: %s\n' "$1" "$2"; }
{ doc Secret a; doc Secret b; doc ConfigMap c; } >"$T/before.yaml"
{ doc Secret a; } >"$T/after.yaml"
run() { out=$(PATH="$T/bin:$PATH" bash scripts/lib/secret-deletion-guard.sh --context kind-x --ns agentic-os "$T/before.yaml" "$T/after.yaml" 2>&1); rc=$?; }

: >"$T/live/b"                     # live b, no keep annotation
run; rc_is "dropping a live Secret without keep is refused" 1
check "the refusal names it and the handover" "SECRET_DELETION_REFUSED — this change would DELETE the live Secret(s): b" "$out"
printf keep >"$T/live/b"
run; rc_is "with keep on the live object it passes" 0
check "says Helm leaves it" "Secret b: no longer rendered; the live object carries helm.sh/resource-policy: keep" "$out"
rm "$T/live/b"
run; rc_is "a dropped Secret that is not live passes" 0
{ doc Secret a; doc Secret b; } >"$T/after.yaml"; : >"$T/live/b"
run; rc_is "no Secret dropped → passes" 0
absent "a dropped ConfigMap is not this guard's business" "SECRET_DELETION_REFUSED" "$out"
[ -z "$(grep -v ' get secret ' "$T/calls")" ] && ok "only get secret calls" || bad "only get secret calls" "$(cat "$T/calls")"
check "uses the given context" "--context kind-x" "$(cat "$T/calls")"
{ doc Secret a; } >"$T/after.yaml"; printf keep >"$T/live/b"
FAKE_KUBECTL_FAIL=1 run; rc_is "FAIL CLOSED: a kubectl error refuses (never 'not on the cluster')" 1
check "the refusal says it could not read the Secret" "cannot read the live Secret(s): b (kubectl failed)" "$out"
absent "a kubectl error is not reported as absent" "not on the cluster" "$out"
rm "$T/live/b"
run; rc_is "an explicit NotFound still passes" 0
grep -q 'secret-deletion-guard.sh --context "$CTX" --ns "$NS" "$WORK/before.yaml" "$WORK/after.yaml" || exit 1' scripts/deploy.sh \
  && ok "deploy.sh runs the guard before the upgrade" || bad "deploy.sh runs the guard before the upgrade"
grep -q 'secret-deletion-guard.sh --context "$CTX" --ns "$NS" "$CAPF.cur" "$CAPF.tgt"' scripts/rollback.sh \
  && ok "rollback.sh runs the guard before the rollback" || bad "rollback.sh runs the guard before the rollback"
finish secret-deletion-guard
