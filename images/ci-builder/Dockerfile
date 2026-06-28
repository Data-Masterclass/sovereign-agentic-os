# Sovereign OS CI builder — the job-container image for Forgejo Actions.
# Gives workflow steps a docker-capable toolbox (docker CLI + buildx + git + curl)
# that talks to the in-cluster Docker-in-Docker daemon via $DOCKER_HOST.
# Bases pinned by multi-arch (OCI index) digest; CLI/buildx copied from the
# official docker image so the versions match the DinD daemon (27.x).

# --- docker CLI + buildx plugin (static Go binaries, version-matched to DinD) ---
FROM docker:27.5.1-cli@sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c AS dockercli

# --- runtime: Node 20 (bookworm) toolbox ---
FROM node:20-bookworm@sha256:8f693eaa7e0a8e71560c9a82b55fd54c2ae920a2ba5d2cde28bac7d1c01c9ba5

# git + curl + ca-certificates (node:bookworm ships git/curl, but pin them explicitly
# so the toolbox is self-describing and reproducible).
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
 && rm -rf /var/lib/apt/lists/*

# Docker CLI + buildx plugin from the pinned docker image.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx

# Default daemon endpoint: the in-pod DinD over TCP (job containers run on the
# pod network — see docs/components/ci-build.md). Overridable per-workflow.
ENV DOCKER_HOST=tcp://localhost:2375

# Sanity-check the toolbox at build time (fails the build if a binary is broken).
RUN docker --version \
 && docker buildx version \
 && git --version \
 && curl --version | head -1

# act_runner execs this image and drives the job; a plain login shell is enough.
CMD ["/bin/bash"]
