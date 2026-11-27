# shellcheck shell=bash
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# local-images.sh — build the images a local (kind) install needs from this checkout and load them into kind.
# Source it; do not run it. Used by scripts/os and tests/e2e/kind/up.sh.
#
#   build_local_images <kind-cluster> <plan-file>
#       <plan-file>: the output of `python3 scripts/lib/local-images.py plan -f <values>...`
#       (key, ref, dockerfile, context, target; '-' = none).
#   docker_build_args   the proxy flags every `docker build` gets (prints one flag per line)
#
# Behaviour (pilot install, Nov 2026):
#   - The build output goes to a log file per image, not to /dev/null: `docker build -q` printed nothing but
#     "exit code: 1" when a build failed behind a firewall. On failure the last LOCAL_IMAGES_LOG_TAIL (80) lines
#     are printed with the log's path. OS_VERBOSE=1 streams the build output instead.
#   - HTTP_PROXY / HTTPS_PROXY / NO_PROXY / ALL_PROXY / FTP_PROXY (and the lower-case forms) are handed to the
#     build as Docker's predefined proxy build args when they are set in the environment (`--build-arg NAME`,
#     value read from the environment, kept out of the image history). OS_BUILD_NETWORK=host adds
#     `--network host` for a proxy that listens on the host's loopback.
#   - LOCAL_IMAGES_ONLY="dagster gitHttp" limits the build to those keys (iterations); LOCAL_IMAGES_SKIP_LOAD=1
#     builds without `kind load` (tests).
#   - LOCAL_IMAGES_PRUNE=1 (disk-constrained CI runners): once an image is loaded into kind, its host copy and the
#     build cache are removed (`docker image rm`, `docker builder prune -af`), so the runner never holds every image
#     twice (host Docker + kind node). Later builds re-pull their base layers; a laptop leaves this off.

docker_build_args() {
  local v
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY ALL_PROXY FTP_PROXY http_proxy https_proxy no_proxy all_proxy ftp_proxy; do
    if [ -n "${!v:-}" ]; then printf '%s\n' --build-arg "$v"; fi
  done
  if [ "${OS_BUILD_NETWORK:-}" = host ]; then printf '%s\n' --network host; fi
}

build_local_images() {
  local cluster=$1 plan=$2 logdir key ref dockerfile ctx target log status
  logdir=${LOCAL_IMAGES_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/sovereign-os-build.XXXXXX")}
  mkdir -p "$logdir"
  local extra=()
  while IFS= read -r line; do extra+=("$line"); done < <(docker_build_args)
  while IFS=$'\t' read -r key ref dockerfile ctx target; do
    [ -n "$key" ] || continue
    if [ -n "${LOCAL_IMAGES_ONLY:-}" ] && ! [[ " $LOCAL_IMAGES_ONLY " == *" $key "* ]]; then continue; fi
    local args=(build -t "$ref")
    [ "$dockerfile" = "-" ] || args+=(-f "$dockerfile")
    [ "$target" = "-" ] || [ -z "$target" ] || args+=("--target=$target")
    [ ${#extra[@]} -eq 0 ] || args+=("${extra[@]}")
    args+=("$ctx")
    log="$logdir/$key.log"
    printf '   building %-16s %s\n' "$key" "$ref"
    status=0
    if [ "${OS_VERBOSE:-0}" = 1 ]; then
      BUILDKIT_PROGRESS=plain docker "${args[@]}" 2>&1 | tee "$log" || status=${PIPESTATUS[0]}
    else
      BUILDKIT_PROGRESS=plain docker "${args[@]}" >"$log" 2>&1 || status=$?
    fi
    if [ "$status" -ne 0 ]; then
      {
        echo
        echo "!! docker build of $key ($ref) failed (exit $status). Last ${LOCAL_IMAGES_LOG_TAIL:-80} lines:"
        echo "---------------------------------------------------------------------------------"
        tail -n "${LOCAL_IMAGES_LOG_TAIL:-80}" "$log"
        echo "---------------------------------------------------------------------------------"
        echo "!! full log: $log"
        echo "!! behind a firewall or proxy? docs/ops/install.md lists every host the builds need;"
        echo "!! HTTP_PROXY/HTTPS_PROXY/NO_PROXY set in this shell are passed to the build. Retry one image:"
        echo "!!   OS_VERBOSE=1 LOCAL_IMAGES_ONLY=$key ./scripts/os up"
      } >&2
      return 1
    fi
    if [ "${LOCAL_IMAGES_SKIP_LOAD:-0}" != 1 ]; then
      if ! kind load docker-image "$ref" --name "$cluster" >"$log.load" 2>&1; then
        echo "!! kind load docker-image $ref failed:" >&2; tail -n 20 "$log.load" >&2; return 1
      fi
      if [ "${LOCAL_IMAGES_PRUNE:-0}" = 1 ]; then
        docker image rm -f "$ref" >>"$log.load" 2>&1 || true
        docker builder prune -af >>"$log.load" 2>&1 || true
      fi
    fi
  done <"$plan"
}
