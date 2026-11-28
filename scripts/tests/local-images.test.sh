#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# local-images.test.sh — the local (kind) profile runs only images that are public or built by scripts/os.
# =============================================================================
#   bash scripts/tests/local-images.test.sh      (needs helm and the subchart .tgz: scripts/lib/helm-deps.sh)
#
# A pilot install without the org's registry credential ended in ImagePullBackOff for Dagster (webserver,
# daemon, code location, repo-sync sidecar) and the git sidecars (Nov 2026). The REAL `helm template` of the local
# profile is judged here:
#   - every image in the render is either built by scripts/os (scripts/lib/local-images.py plan) or not one of
#     ours (no ghcr.io/data-masterclass, ghcr.io/aborek or sovereign-os/ image left that the script does not build);
#   - the generated Dagster code-location block in values.local.yaml matches values.yaml (gen-values --check);
#   - `plan` refuses an image still pinned by registry digest (a local build cannot carry it);
#   - the Dagster run launcher does not force `Always` pulls; the run-pod admission policy allows the local image;
#   - the render prints no "destination for litellm.ingress.hosts is a table" warning (12a);
#   - docs/ops/install.md names every network destination derived from the Dockerfiles and Chart.yaml;
#   - no workflow or script resolves the chart dependencies without adding the repositories (helm-deps.sh).
# Each check has a negative twin.
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
command -v helm >/dev/null || { echo "helm not on PATH"; exit 2; }
ls charts/sovereign-agentic-os/charts/*.tgz >/dev/null 2>&1 || { echo "no subchart .tgz (bash scripts/lib/helm-deps.sh)"; exit 2; }
CHART=charts/sovereign-agentic-os

# scripts/os sets the NodePort; its sources come from values.local.yaml. The twins below render WITHOUT
# values.local.yaml, and a NodePort without osUI.service.nodePortAllowedCIDRs is refused by the chart
# (os-ui-nodeport-policy.yaml), so the sources are named here too — the laptop's value, nothing wider.
render() { helm template agentic-os "$CHART" -n agentic-os --set osUI.service.nodePort=30080 --set 'osUI.service.nodePortAllowedCIDRs={0.0.0.0/0}' "$@" 2>"$TMP/stderr"; }
images_of() { grep -E '^[[:space:]]*(- )?image:[[:space:]]' | sed -E "s/^[[:space:]]*(- )?image:[[:space:]]*//; s/[\"']//g; s/[[:space:]]+#.*//" | sort -u; }
# unbuilt_ours <render-images-file> <plan-refs-file>: our images in the render that the script does not build
unbuilt_ours() { grep -vxF -f "$2" "$1" | grep -E '^(ghcr\.io/(data-masterclass|aborek)/|sovereign-os/)' || true; }

echo "images of the local render"
render -f values.local.yaml >"$TMP/local.yaml"; rc=$?
rc_is "the local profile renders" 0
images_of <"$TMP/local.yaml" >"$TMP/images"
python3 scripts/lib/local-images.py plan -f values.local.yaml | cut -f2 >"$TMP/plan"; rc=$?
rc_is "the build plan resolves" 0
left=$(unbuilt_ours "$TMP/images" "$TMP/plan")
holds "every OS image in the local render is built by scripts/os${left:+ (missing: $(echo $left))}" [ -z "$left" ]
for img in sovereign-os/dagster:local sovereign-os/git-daemon:local sovereign-os/git-http:local; do
  check "the render runs $img" "$img" "$(cat "$TMP/images")"
done
absent "no Dagster image is pulled by digest from the private package" "sovereign-os/dagster@sha256" "$(cat "$TMP/local.yaml")"
absent "the repo-sync sidecar is not the private digest" "dagster:0.4.2@sha256" "$(cat "$TMP/local.yaml")"
check "the run launcher pulls IfNotPresent (not Always)" "image_pull_policy: IfNotPresent" "$(grep -A0 'image_pull_policy' "$TMP/local.yaml")"
check "the run-pod admission policy allows the local Dagster image" '\"sovereign-os/dagster:local\"' "$(grep 'pinned Dagster' -B1 "$TMP/local.yaml")"
check "DAGSTER_CURRENT_IMAGE (run pods) is the local image" "sovereign-os/dagster:local" "$(grep -A1 DAGSTER_CURRENT_IMAGE "$TMP/local.yaml")"
# twin: the chart defaults (what the pilot's values.local.yaml rendered for Dagster and git) leave private images
render >"$TMP/default.yaml"; images_of <"$TMP/default.yaml" >"$TMP/default-images"
twin=$(unbuilt_ours "$TMP/default-images" "$TMP/plan")
check "twin: without the local overrides the Dagster digest is left unbuilt" "ghcr.io/data-masterclass/sovereign-os/dagster" "$twin"
check "twin: …and the git-daemon package" "ghcr.io/aborek/sovereign-os/git-daemon" "$twin"

echo "the generated code-location block"
python3 scripts/lib/local-images.py gen-values --check; rc=$?
rc_is "values.local.yaml's generated block matches values.yaml" 0
cp "$CHART/values.yaml" "$TMP/values.yaml"
python3 - "$TMP/values.yaml" <<'PY'
import sys
p = sys.argv[1]; t = open(p).read()
open(p, "w").write(t.replace('{ name: REPO_SYNC_INTERVAL, value: "15" }', '{ name: REPO_SYNC_INTERVAL, value: "30" }', 1))
PY
python3 scripts/lib/local-images.py gen-values --check --values "$TMP/values.yaml" 2>/dev/null; rc=$?
rc_is "twin: a values.yaml change to the code location makes the block stale" 1

echo "digest pins are refused"
printf 'litellm:\n  image:\n    repository: ghcr.io/data-masterclass/sovereign-os/litellm-oss\n    tag: "1.109.1-soa.4@sha256:2685"\n' >"$TMP/pinned.yaml"
out=$(python3 scripts/lib/local-images.py plan -f values.local.yaml -f "$TMP/pinned.yaml" 2>&1); rc=$?
rc_is "plan fails for an image pinned by digest" 1
check "…naming it and the fix" "litellm: ghcr.io/data-masterclass/sovereign-os/litellm-oss:1.109.1-soa.4@sha256:2685 is pinned by registry digest" "$out"
printf 'dagster:\n  dagsterWebserver:\n    image:\n      digest: "sha256:1ef2"\n' >"$TMP/pinned2.yaml"
out=$(python3 scripts/lib/local-images.py plan -f values.local.yaml -f "$TMP/pinned2.yaml" 2>&1); rc=$?
rc_is "plan fails for a separate digest field" 1

echo "12a: no type-conflict warning"
warned=0
for _ in 1 2 3 4 5; do render -f values.local.yaml >/dev/null; grep -q 'destination for litellm.ingress.hosts' "$TMP/stderr" && warned=$((warned+1)); done
holds "the local render prints no litellm.ingress.hosts warning (0/5, got $warned/5)" [ "$warned" = 0 ]
warned=0
for _ in 1 2 3 4 5; do render >/dev/null; grep -q 'destination for' "$TMP/stderr" && warned=$((warned+1)); done
holds "the default render prints no 'destination for' warning ($warned/5)" [ "$warned" = 0 ]
printf 'ingress:\n  hosts: {}\n' >"$TMP/hosts.yaml"
render -f values.local.yaml -f "$TMP/hosts.yaml" >/dev/null
check "twin: the old \`ingress.hosts: {}\` default brings the warning back" "destination for litellm.ingress.hosts is a table" "$(cat "$TMP/stderr")"
render --set global.allowChartDefaultSecrets=true --set ingress.enabled=true --set ingress.hosts.osUI=os.example.test --set osUI.publicUrl=https://os.example.test >"$TMP/ing.yaml"; rc=$?
rc_is "ingress.hosts still works when set" 0
check "…and renders the os-ui Ingress" "host: \"os.example.test\"" "$(cat "$TMP/ing.yaml")"

echo "network destinations are documented"
doc_missing() { # <doc> → hosts from `local-images.py hosts` that the doc does not name
  python3 scripts/lib/local-images.py hosts | cut -f1 | while read -r h; do grep -qF "\`$h\`" "$1" || echo "$h"; done
}
miss=$(doc_missing docs/ops/install.md)
holds "docs/ops/install.md names every derived host${miss:+ (missing: $(echo $miss))}" [ -z "$miss" ]
hosts=$(python3 scripts/lib/local-images.py hosts | cut -f1)
for h in registry.npmjs.org dl-cdn.alpinelinux.org deb.debian.org pypi.org files.pythonhosted.org nodejs.org binaries.prisma.sh \
         proxy.golang.org sum.golang.org huggingface.co github.com quay.io langfuse.github.io dagster-io.github.io opensearch-project.github.io; do
  check "derived from the Dockerfiles/Chart.yaml: $h" "$h" "$hosts"
done
grep -vF '`binaries.prisma.sh`' docs/ops/install.md >"$TMP/doc.md"
check "twin: a doc without a needed host is caught" "binaries.prisma.sh" "$(doc_missing "$TMP/doc.md")"
check "the doc says Debian needs port 80" "port 80" "$(grep deb.debian.org docs/ops/install.md)"

echo "chart dependencies always add the repositories first"
plain=$(grep -rnHE 'helm dependency (build|update)' .github/workflows tests/e2e/kind/up.sh scripts/os | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)
holds "no workflow or install script runs helm dependency build/update itself${plain:+: $plain}" [ -z "$plain" ]
check "scripts/os uses helm-deps.sh" "scripts/lib/helm-deps.sh" "$(cat scripts/os)"
check "the kind e2e uses helm-deps.sh" "scripts/lib/helm-deps.sh" "$(cat tests/e2e/kind/up.sh)"
check "the kind e2e builds from the same plan as scripts/os" "scripts/lib/local-images.py plan" "$(cat tests/e2e/kind/up.sh)"
check "the dev deploy uses helm-deps.sh" "scripts/lib/helm-deps.sh" "$(grep -A3 'Resolve chart dependencies' .github/workflows/dev.yml)"
printf 'run: |\n  helm dependency build charts/sovereign-agentic-os\n' >"$TMP/wf.yml"
twin=$(grep -rnHE 'helm dependency (build|update)' "$TMP/wf.yml" | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)
check "twin: a plain dependency build is caught" "helm dependency build" "$twin"

finish local-images.test.sh
