# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG
#
# git-daemon — the read-only `git://` server that sits beside os-ui and exports every domain
# repository on the `os-repos` volume to the Dagster repo-sync sidecar.
#
# Why our own image: no stock git image ships the `daemon` subcommand. Alpine packages it
# separately (`git-daemon`), and alpine/git, bitnami/git and chainguard/git all omit it — the
# first production rollout of 0.8.0 crash-looped on exactly that and took os-ui's pod out of
# the Service (a pod is Ready only when every container is). The build step below FAILS if the
# daemon binary is absent, so the image can never ship without it again.
#
# git is GPL-2.0 and runs as a separate process from a distro package — nothing links to it.
FROM alpine:3.21
RUN apk add --no-cache git git-daemon \
 && test -x "$(git --exec-path)/git-daemon" \
 && git --version
# Runs as the chart's non-root securityContext with a read-only root filesystem; the daemon
# needs no writable path. The chart supplies the full command (--export-all, --base-path=/repos).
USER 65532:65532
ENTRYPOINT ["git"]
CMD ["daemon", "--help"]
