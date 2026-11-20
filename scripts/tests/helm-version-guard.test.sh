#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# helm-version-guard.test.sh — scripts/lib/helm-version-guard.sh against a fake helm: Helm 4+
# passes, Helm 3 refuses, an unreadable or failing `helm version` refuses (fail closed); and
# deploy.sh + rollback.sh call it.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
cat >"$T/helm" <<'SH'
#!/usr/bin/env bash
[ "$1" = version ] || exit 9
[ -n "${FAKE_HELM_FAIL:-}" ] && exit 1
printf '%s' "$FAKE_HELM_VERSION"
SH
chmod +x "$T/helm"
run() { out=$(PATH="$T:$PATH" FAKE_HELM_VERSION=$1 bash scripts/lib/helm-version-guard.sh 2>&1); rc=$?; }
run v4.2.2;  rc_is "Helm v4.2.2 passes" 0; check "prints the version" "helm v4.2.2" "$out"
run v5.0.0;  rc_is "Helm v5 passes" 0
run v3.16.3; rc_is "Helm v3.16.3 refuses" 1; check "names the version" "HELM_VERSION_REFUSED — Helm v3.16.3 is below 4" "$out"
run "";      rc_is "an empty version refuses (fail closed)" 1
run garbage; rc_is "an unparsable version refuses" 1; check "says it cannot read it" "cannot read the Helm client version" "$out"
out=$(PATH="$T:$PATH" FAKE_HELM_FAIL=1 FAKE_HELM_VERSION=v4.2.2 bash scripts/lib/helm-version-guard.sh 2>&1); rc=$?
rc_is "a failing helm version refuses" 1
grep -q 'bash scripts/lib/helm-version-guard.sh || exit 1' scripts/deploy.sh && ok "deploy.sh calls the guard" || bad "deploy.sh calls the guard"
grep -q 'hv=$(bash scripts/lib/helm-version-guard.sh' scripts/rollback.sh && ok "rollback.sh calls the guard" || bad "rollback.sh calls the guard"
for wf in dev prod rollback; do
  if grep -A2 'azure/setup-helm' ".github/workflows/$wf.yml" | grep -q 'version: v3'; then bad "$wf.yml installs Helm 3"; else ok "$wf.yml installs Helm 4"; fi
done
finish helm-version-guard
