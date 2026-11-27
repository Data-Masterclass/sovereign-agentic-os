#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# scripts/lib/adopt-secret.sh against a fake kubectl: absent, already owned, hand-made (adopted),
# owned by another release (refused), unreadable (fail closed).
set -uo pipefail
cd "$(dirname "$0")/../.."
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat > "$T/kubectl" <<'K'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *"get secret"*"--ignore-not-found"*)
    [ -n "${FAKE_ERR:-}" ] && { echo "Unable to connect to the server" >&2; exit 1; }
    [ "${FAKE_STATE:-absent}" = absent ] || echo "secret/dagster-postgresql" ;;
  *"get secret"*jsonpath*)
    case $FAKE_STATE in
      owned) echo "Helm|agentic-os|agentic-os" ;;
      other) echo "Helm|someone-else|agentic-os" ;;
      plain) echo "||" ;;
    esac ;;
  *label*|*annotate*) : ;;
  *) exit 1 ;;
esac
K
chmod +x "$T/kubectl"
run() { : > "$T/log"; out=$(KUBECTL="$T/kubectl" FAKE_LOG="$T/log" "$@" bash scripts/lib/adopt-secret.sh dmagosdev agentic-os agentic-os dagster-postgresql 2>&1); rc=$?; log=$(cat "$T/log"); }
run env FAKE_STATE=absent
rc_is "absent: exit 0" 0; check "  says the chart creates it" "absent — the chart creates it" "$out"; absent "  writes nothing" "label" "$log"
run env FAKE_STATE=owned
rc_is "owned by this release: exit 0" 0; check "  nothing to adopt" "nothing to adopt" "$out"; absent "  writes nothing" "annotate" "$log"
run env FAKE_STATE=plain
rc_is "hand-made: exit 0" 0; check "  adopted" "adopted into release agentic-os" "$out"
check "  labelled managed-by=Helm" "label secret dagster-postgresql app.kubernetes.io/managed-by=Helm --overwrite" "$log"
check "  annotated with the release" "meta.helm.sh/release-name=agentic-os meta.helm.sh/release-namespace=agentic-os" "$log"
check "  on the given context" "--context dmagosdev -n agentic-os" "$log"
run env FAKE_STATE=other
rc_is "another release's Secret: refused" 1; check "  saying whose" "belongs to Helm release 'someone-else'" "$out"; absent "  writes nothing" "annotate" "$log"
run env FAKE_ERR=1 FAKE_STATE=plain
rc_is "kubectl fails: refused (fail closed)" 1; check "  saying so" "ADOPT_SECRET_UNREADABLE" "$out"; absent "  writes nothing" "label" "$log"
finish adopt-secret.test.sh && echo ADOPT_SECRET_TESTS_OK
