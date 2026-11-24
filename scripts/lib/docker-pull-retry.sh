# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Sourced by test harnesses: `pull_retry <image>...` pulls each image (already present → no network) with a bounded
# number of attempts (3), each failure logged, before the harness `docker run`s it. A registry or CDN blip ("failed to
# copy: httpReadSeeker: failed open … production.cloudfront.docker.com", CI 22 Nov 2026) otherwise failed the whole job
# at an implicit pull inside `docker run`. A third failure still fails the harness, loudly.
pull_retry() {
  local img a
  for img in "$@"; do
    docker image inspect "$img" >/dev/null 2>&1 && continue
    for a in 1 2 3; do
      if docker pull -q "$img" >/dev/null; then break; fi
      if [ "$a" = 3 ]; then echo "pull_retry: $img could not be pulled after 3 attempts" >&2; return 1; fi
      echo "pull_retry: pulling $img failed (attempt $a/3), retrying in $((a * 10)) s" >&2
      sleep $((a * 10))
    done
  done
}
