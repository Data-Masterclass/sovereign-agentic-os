#!/usr/bin/env bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
# =============================================================================
# os-up.test.sh — `./scripts/os up` on a fresh machine behind a firewall (pilot install, Nov 2026).
# =============================================================================
#   bash scripts/tests/os-up.test.sh
#
# The REAL scripts/os, scripts/lib/local-images.{py,sh} and scripts/lib/helm-deps.sh run in a throwaway copy
# of the tree, with docker, kind, helm, kubectl and curl replaced by fakes on PATH that record their arguments.
# Each fix has a negative twin showing the failure it prevents:
#   1. a failing `docker build` prints the build log (the old `docker build -q` showed only "exit code: 1");
#   2. HTTP(S)_PROXY / NO_PROXY reach every build as `--build-arg NAME` (value not on the command line);
#   3. on a machine with no helm repositories, the chart repositories are added before `dependency build`
#      (plain `helm dependency build` fails there with "no repository definition"), and repeating is safe;
#   4. every image of the build plan is built and kind-loaded, including the git sidecars;
#   9. the health check is bounded per probe (--max-time) and overall (OS_HEALTH_DEADLINE), with a message;
#   +  a failed install or rollout prints a diagnosis (pods not Ready, image pull problems, warning events).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2
. scripts/tests/assert.sh
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
python3 -c 'import yaml' || { echo "python3 needs PyYAML"; exit 2; }

# ---- a throwaway tree with the files `os up` reads ---------------------------------------------------------
T=$TMP/tree
mkdir -p "$T/scripts/lib" "$T/charts/sovereign-agentic-os/charts"
cp scripts/os "$T/scripts/"; cp scripts/lib/local-images.py scripts/lib/local-images.sh scripts/lib/helm-deps.sh \
  scripts/lib/offline-subchart-schemas.py scripts/lib/k8s-definitions-v1.19.0.json "$T/scripts/lib/"
cp charts/sovereign-agentic-os/Chart.yaml charts/sovereign-agentic-os/Chart.lock charts/sovereign-agentic-os/values.yaml \
  "$T/charts/sovereign-agentic-os/"
cp values.local.yaml kind-config.yaml "$T/"

# ---- fakes ---------------------------------------------------------------------------------------------------
BIN=$TMP/bin; mkdir -p "$BIN"
export FAKE_LOG=$TMP/calls.log FAKE_REPOS=$TMP/repos
cat >"$BIN/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >>"$FAKE_LOG"
case "$1" in
  build)
    echo "#1 [internal] load build definition from Dockerfile"
    for a in "$@"; do case "$a" in *"$FAKE_DOCKER_FAIL_CTX"*) if [ -n "${FAKE_DOCKER_FAIL_CTX:-}" ]; then
      echo "#7 0.512 fetch https://dl-cdn.alpinelinux.org/alpine/v3.21/main/x86_64/APKINDEX.tar.gz"
      echo "#7 30.61 WARNING: updating and opening https://dl-cdn.alpinelinux.org/alpine/v3.21/main: temporary error (try again later)"
      echo "ERROR: failed to solve: process \"/bin/sh -c apk add --no-cache tinyproxy\" did not complete successfully: exit code: 1"
      exit 1; fi ;; esac; done
    echo "#9 DONE 0.1s" ;;
  exec) echo "Avail"; echo "100G" ;;
esac
exit 0
EOF
cat >"$BIN/kind" <<'EOF'
#!/usr/bin/env bash
echo "kind $*" >>"$FAKE_LOG"
case "$1" in get) echo "sovereign-os" ;; esac
exit 0
EOF
# helm: `dependency build` needs every http(s) repository of Chart.yaml registered, like the real one.
cat >"$BIN/helm" <<'EOF'
#!/usr/bin/env bash
echo "helm $*" >>"$FAKE_LOG"
case "$1 $2" in
  "repo add") set -- $(printf '%s\n' "$@" | grep -v '^--'); n=$3; u=$4; touch "$FAKE_REPOS"; grep -v "^$n " "$FAKE_REPOS" >"$FAKE_REPOS.t"; echo "$n $u" >>"$FAKE_REPOS.t"; mv "$FAKE_REPOS.t" "$FAKE_REPOS" ;;
  "dependency build")
    missing=""
    for u in $(grep -oE '^\s*repository:\s*"?https?://[^"]+' "$3/Chart.yaml" | grep -oE 'https?://[^"]+'); do
      grep -q " $u\$" "$FAKE_REPOS" 2>/dev/null || missing="$missing${missing:+, }$u"
    done
    if [ -n "$missing" ]; then echo "Error: no repository definition for $missing. Please add the missing repos via 'helm repo add'" >&2; exit 1; fi ;;
  "upgrade --install") [ "${FAKE_HELM_UPGRADE_FAIL:-0}" = 1 ] && { echo "Error: INSTALLATION FAILED: context deadline exceeded" >&2; exit 1; } ;;
esac
exit 0
EOF
cat >"$BIN/kubectl" <<'EOF'
#!/usr/bin/env bash
echo "kubectl $*" >>"$FAKE_LOG"
case "$*" in
  *"rollout status"*) [ "${FAKE_ROLLOUT_FAIL:-0}" = 1 ] && { echo "error: timed out waiting for the condition" >&2; exit 1; } ;;
  *"custom-columns"*) printf 'os-ui-5d9   Running   true   <none>   <none>   <none>\nagentic-os-dagster-daemon-77   Pending   false   ImagePullBackOff   <none>   <none>\n' ;;
  *"jsonpath"*) printf 'ImagePullBackOff ghcr.io/data-masterclass/sovereign-os/dagster@sha256:1ef2\n\n' ;;
  *"get events"*) printf 'LAST SEEN   TYPE      REASON   OBJECT   MESSAGE\n2m   Warning   Failed   pod/agentic-os-dagster-daemon-77   Failed to pull image: unauthorized\n' ;;
  *"get pods --no-headers"*) echo "os-ui-5d9   1/1   Running   0   1m" ;;
esac
exit 0
EOF
# curl: answers when FAKE_CURL_OK=1. Without --max-time it hangs, like a real curl on a silent connection.
cat >"$BIN/curl" <<'EOF'
#!/usr/bin/env bash
echo "curl $*" >>"$FAKE_LOG"
case " $* " in *" --max-time "*) ;; *) sleep 30 ;; esac
[ "${FAKE_CURL_OK:-0}" = 1 ] && { echo '{"ok":true}'; exit 0; }
exit 7
EOF
chmod +x "$BIN"/*
export PATH="$BIN:$PATH" OS_HEALTH_INTERVAL=1 FAKE_CURL_OK=1
# a portable `timeout` (macOS has none): perl's alarm, then exec
limit() { perl -e 'alarm shift; exec @ARGV or die' "$@"; }
run_up() { : >"$FAKE_LOG"; rm -f "$FAKE_REPOS"; out=$(cd "$T" && limit 120 bash scripts/os up 2>&1); rc=$?; }

echo "1. build failures show the build log"
FAKE_DOCKER_FAIL_CTX=images/base/egress-proxy run_up
rc_is "os up fails when a build fails" 1
check "the failing image is named" "docker build of egressProxy" "$out"
check "the build log's error line is printed" "temporary error (try again later)" "$out"
check "the full log's path is printed" "full log:" "$out"
check "the retry-one-image hint is printed" "LOCAL_IMAGES_ONLY=egressProxy" "$out"
absent "nothing after the failed build ran (no helm)" "helm upgrade" "$(cat "$FAKE_LOG")"
# negative twin: the old `docker build -q ... >/dev/null` kept none of that
twin=$(cd "$T" && FAKE_DOCKER_FAIL_CTX=images/base/egress-proxy docker build -q -t x images/base/egress-proxy >/dev/null 2>&1; echo "exit code: $?")
absent "twin: the old quiet build printed no reason" "temporary error" "$twin"

echo "2. proxy variables reach the builds"
HTTPS_PROXY=http://proxy.example:3128 NO_PROXY=localhost,.svc no_proxy=localhost run_up
builds=$(grep '^docker build' "$FAKE_LOG")
check "HTTPS_PROXY is a build arg" "--build-arg HTTPS_PROXY" "$builds"
check "NO_PROXY is a build arg" "--build-arg NO_PROXY" "$builds"
check "no_proxy (lower case) is a build arg" "--build-arg no_proxy" "$builds"
absent "the proxy value is not on the command line" "proxy.example" "$builds"
absent "an unset variable is not passed" "--build-arg HTTP_PROXY " "$builds"
n_builds=$(grep -c '^docker build' "$FAKE_LOG"); n_proxy=$(grep -c '^docker build.*--build-arg HTTPS_PROXY' "$FAKE_LOG")
holds "every build gets the proxy ($n_proxy/$n_builds)" [ "$n_builds" -gt 0 ] && holds "  …all of them" [ "$n_builds" = "$n_proxy" ]
OS_BUILD_NETWORK=host run_up
check "OS_BUILD_NETWORK=host adds --network host" "--network host" "$(grep '^docker build' "$FAKE_LOG")"
run_up
absent "twin: without proxy variables no --build-arg" "--build-arg" "$(grep '^docker build' "$FAKE_LOG")"

echo "3. chart repositories on a fresh machine"
run_up
rc_is "os up succeeds with every fake answering" 0
for u in https://langfuse.github.io/langfuse-k8s https://opensearch-project.github.io/helm-charts https://dagster-io.github.io/helm; do
  check "repo added before dependency build: $u" "$u" "$(cat "$FAKE_REPOS")"
done
absent "the OCI repository is not added (helm needs none)" "oci://" "$(grep 'repo add' "$FAKE_LOG")"
first_add=$(grep -n 'helm repo add' "$FAKE_LOG" | head -1 | cut -d: -f1); dep=$(grep -n 'helm dependency build' "$FAKE_LOG" | head -1 | cut -d: -f1)
holds "repo add comes before dependency build" [ "${first_add:-999}" -lt "${dep:-0}" ]
check "repo add is idempotent (--force-update)" "repo add --force-update" "$(grep 'repo add' "$FAKE_LOG")"
(cd "$T" && bash scripts/lib/helm-deps.sh charts/sovereign-agentic-os >/dev/null 2>&1 && bash scripts/lib/helm-deps.sh charts/sovereign-agentic-os >/dev/null 2>&1); rc=$?
rc_is "running it twice on the same machine succeeds" 0
holds "…and registers each repository once" [ "$(wc -l <"$FAKE_REPOS" | tr -d ' ')" = 3 ]
rm -f "$FAKE_REPOS"; out=$(helm dependency build "$T/charts/sovereign-agentic-os" 2>&1); rc=$?
rc_is "twin: plain helm dependency build on a fresh machine fails" 1
check "twin: …with the error the pilot saw" "no repository definition" "$out"

echo "4. every planned image is built and loaded into kind"
run_up
plan=$(cd "$T" && python3 scripts/lib/local-images.py plan -f values.local.yaml | cut -f2)
for ref in $plan; do
  check "built and loaded: $ref" "kind load docker-image $ref --name sovereign-os" "$(cat "$FAKE_LOG")"
done
check "the git-daemon image is in the plan" "sovereign-os/git-daemon:local" "$plan"
check "the git-http image is in the plan" "sovereign-os/git-http:local" "$plan"
check "the Dagster image is a local tag" "sovereign-os/dagster:local" "$plan"
absent "no build writes to /dev/null quietly (-q)" " -q " "$(grep '^docker build' "$FAKE_LOG")"

LOCAL_IMAGES_PRUNE=1 run_up
check "LOCAL_IMAGES_PRUNE=1 removes the host copy after kind load" "docker image rm -f sovereign-os/git-http:local" "$(cat "$FAKE_LOG")"
check "…and the build cache" "docker builder prune -af" "$(cat "$FAKE_LOG")"
load=$(grep -n 'kind load docker-image sovereign-os/git-http:local' "$FAKE_LOG" | cut -d: -f1); rm_=$(grep -n 'docker image rm -f sovereign-os/git-http:local' "$FAKE_LOG" | cut -d: -f1)
holds "…only after the image is in the node" [ "${load:-999}" -lt "${rm_:-0}" ]
run_up
absent "twin: without it nothing is removed (laptop)" "docker image rm" "$(cat "$FAKE_LOG")"

echo "9. the health check is bounded"
start=$(date +%s); OS_HEALTH_DEADLINE=3 FAKE_CURL_OK=0 run_up; took=$(( $(date +%s) - start ))
rc_is "os up fails when /api/health never answers" 1
check "the message names the deadline" "did not answer within 3s" "$out"
holds "it returns near the deadline, not never ($took s)" [ "$took" -lt 25 ]
check "every probe has --max-time" "--max-time 10" "$(grep '^curl' "$FAKE_LOG" | head -1)"
check "every probe has --connect-timeout" "--connect-timeout 5" "$(grep '^curl' "$FAKE_LOG" | head -1)"
holds "no probe without --max-time" [ "$(grep '^curl' "$FAKE_LOG" | grep -vc -- '--max-time')" = 0 ]
check "the failure prints the diagnosis" "diagnosis (namespace agentic-os)" "$out"
FAKE_CURL_OK=1 run_up
rc_is "os up succeeds when /api/health answers" 0
check "…and prints the URL" "UI:     http://localhost:8080" "$out"
# negative twin: the old loop's probe (no --max-time) against a silent endpoint does not come back in time
start=$(date +%s); limit 5 curl -fsS "http://localhost:8080/api/health" >/dev/null 2>&1; took=$(( $(date +%s) - start ))
holds "twin: a probe without --max-time hangs (cut by the test after ${took}s)" [ "$took" -ge 5 ]

echo "+  failures print a diagnosis instead of hanging"
FAKE_ROLLOUT_FAIL=1 run_up
rc_is "os up fails when the os-ui rollout times out" 1
check "the cause is named" "os-ui did not become ready within" "$out"
check "the not-Ready pod is listed" "agentic-os-dagster-daemon-77" "$out"
check "the image pull problem names the image" "ImagePullBackOff ghcr.io/data-masterclass/sovereign-os/dagster" "$out"
check "the warning events are shown" "Failed to pull image: unauthorized" "$out"
absent "a Ready pod is not listed as a problem" "os-ui-5d9   Running   true" "$out"
check "the diagnosis's kubectl calls are bounded" "--request-timeout=10s" "$(grep 'get events' "$FAKE_LOG")"
FAKE_HELM_UPGRADE_FAIL=1 run_up
rc_is "os up fails when helm upgrade fails" 1
check "…and prints the diagnosis" "last warning events:" "$out"

finish os-up.test.sh
