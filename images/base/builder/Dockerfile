# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# FEATURE: App Builder build platform (workstream C1) - the image every app image is built with.
# USER STORY: As a platform owner I want app images built inside the cluster by a builder that contains only
#   permissively licensed binaries, runs without privilege, and never holds a registry credential.
# ARCHITECTURE: a minimal FROM-scratch image of statically linked binaries built here from pinned upstream source
#   (spec 6.1; pins and docs in components/buildkit/UPSTREAM.md and components/crane/UPSTREAM.md):
#     buildkitd, buildctl  moby/buildkit, Apache-2.0                - the build engine and its client
#     runc                 opencontainers/runc, Apache-2.0          - the OCI runtime buildkitd runs build steps with
#     rootlesskit          rootless-containers/rootlesskit, Apache-2.0 - the nested user namespace buildkitd needs
#     newuidmap/newgidmap  shadow-maint/shadow, BSD-3-Clause        - rootlesskit writes its id map through them
#     crane                google/go-containerregistry, Apache-2.0  - the push step (a separate pod)
#     zot-users            ours, Apache-2.0 (golang.org/x/crypto BSD-3-Clause) - renders Zot's htpasswd + access
#     require-userns       ours, Apache-2.0 (stdlib) - buildkitd's entrypoint: refuses unless the pod has its own userns
#   NOT here, by design: slirp4netns (GPL-2.0), fuse-overlayfs (GPL-3.0+), crun (GPL-2.0+), libseccomp (LGPL-2.1),
#   glibc (LGPL), busybox (GPL-2.0), any shell. The upstream moby/buildkit:*-rootless image is not used because it
#   bundles slirp4netns and fuse-overlayfs. runc is built WITHOUT the `seccomp` tag (that tag links libseccomp,
#   LGPL) and statically against musl (MIT); every build step still runs under the pod's seccomp filter, which the
#   kernel inherits into every child process. buildkitd uses the native snapshotter and the pod's own network
#   namespace (`--oci-worker-net=host`), so the build pod's NetworkPolicy governs what a build can reach.
#
# Build: docker build -t builder images/base/builder   (CI: .github/workflows/build-images.yml, image=builder)
# Licence proof: the image-level SBOM (syft, CycloneDX) is checked by scripts/check-builder-sbom.mjs.

ARG GO_IMAGE=golang:1.27-alpine3.24@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280
ARG ALPINE_IMAGE=alpine:3.24@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf
ARG XX_IMAGE=tonistiigi/xx:1.10.0@sha256:40fe21f44bb8cddf1eb1226db190d0a984118f62ee02a91b77d99448d28264a6

# Pins: the tag AND the commit it must resolve to (a moved tag fails the build).
ARG BUILDKIT_VERSION=v0.35.1
ARG BUILDKIT_COMMIT=412cc86ad3c4252b82e929f9b1b1ad167376ded8
ARG RUNC_VERSION=v1.5.3
ARG RUNC_COMMIT=46365c62967c76a765a5e347f48f0c7b3b571fe9
ARG ROOTLESSKIT_VERSION=v3.3.0
ARG ROOTLESSKIT_COMMIT=888c3189e9cdf34dcdb19011e1c7c34eb94b5393
ARG GGCR_VERSION=v0.22.1
ARG GGCR_COMMIT=8a72a424fdecb4caa14f2d525e5d2503331442b5
ARG SHADOW_VERSION=4.20.4
ARG SHADOW_SHA256=639d03cd7821b4086deba50485a1b8041acbb0d1d3c33c20ebd4708e0eeb9bc7

# ---- sources --------------------------------------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM ${ALPINE_IMAGE} AS src
RUN apk add --no-cache git ca-certificates curl xz
ARG BUILDKIT_VERSION BUILDKIT_COMMIT RUNC_VERSION RUNC_COMMIT ROOTLESSKIT_VERSION ROOTLESSKIT_COMMIT GGCR_VERSION GGCR_COMMIT SHADOW_VERSION SHADOW_SHA256
WORKDIR /src
RUN set -e; \
  fetch() { git -c advice.detachedHead=false clone -q --depth 1 --branch "$2" "https://github.com/$1" "$3"; \
    got="$(git -C "$3" rev-parse HEAD)"; [ "$got" = "$4" ] || { echo "$1 $2 resolved to $got, pinned $4" >&2; exit 1; }; }; \
  fetch moby/buildkit "$BUILDKIT_VERSION" buildkit "$BUILDKIT_COMMIT"; \
  fetch opencontainers/runc "$RUNC_VERSION" runc "$RUNC_COMMIT"; \
  fetch rootless-containers/rootlesskit "$ROOTLESSKIT_VERSION" rootlesskit "$ROOTLESSKIT_COMMIT"; \
  fetch google/go-containerregistry "$GGCR_VERSION" ggcr "$GGCR_COMMIT"; \
  curl -fsSL -o shadow.tar.xz "https://github.com/shadow-maint/shadow/releases/download/${SHADOW_VERSION}/shadow-${SHADOW_VERSION}.tar.xz"; \
  echo "${SHADOW_SHA256}  shadow.tar.xz" | sha256sum -c -; \
  mkdir shadow && tar -xJf shadow.tar.xz -C shadow --strip-components=1 && rm shadow.tar.xz

# ---- pure Go binaries, cross-compiled on the build platform (CGO off: static, no libc at all) ----------------------
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS gobuild
ARG TARGETOS TARGETARCH BUILDKIT_VERSION BUILDKIT_COMMIT
ENV CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} GOFLAGS=-trimpath GOTOOLCHAIN=local
COPY --from=src /src/buildkit /src/buildkit
COPY --from=src /src/rootlesskit /src/rootlesskit
COPY --from=src /src/ggcr /src/ggcr
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build set -e; \
  cd /src/buildkit; \
  ld="-s -w -X github.com/moby/buildkit/version.Version=${BUILDKIT_VERSION} -X github.com/moby/buildkit/version.Revision=${BUILDKIT_COMMIT} -X github.com/moby/buildkit/version.Package=github.com/moby/buildkit"; \
  go build -tags 'osusergo netgo static_build seccomp grpcnotrace' -ldflags "$ld" -o /out/buildkitd ./cmd/buildkitd; \
  go build -tags 'grpcnotrace' -ldflags "$ld" -o /out/buildctl ./cmd/buildctl; \
  cd /src/rootlesskit && go build -ldflags '-s -w' -o /out/rootlesskit ./cmd/rootlesskit; \
  cd /src/ggcr && go build -ldflags '-s -w' -o /out/crane ./cmd/crane
COPY zot-users /src/zot-users
COPY require-userns /src/require-userns
# go test runs on the build platform (GOOS/GOARCH of the host), the binaries are built for the target.
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build set -e; \
  for m in zot-users require-userns; do \
    cd /src/$m; GOOS= GOARCH= go vet ./...; GOOS= GOARCH= go test ./...; go build -mod=readonly -ldflags '-s -w' -o /out/$m .; done

# ---- C binaries, CROSS-compiled on the build platform against musl (MIT), linked statically --------------------------
# tonistiigi/xx (MIT, build-time only; the cross helper BuildKit's own Dockerfile uses): clang + the target's musl
# sysroot, so an amd64 image builds natively on arm64 and vice versa (Go under qemu crashes; this needs no emulation).
FROM --platform=$BUILDPLATFORM ${XX_IMAGE} AS xx
FROM --platform=$BUILDPLATFORM ${GO_IMAGE} AS cbuild
COPY --from=xx / /
RUN apk add --no-cache clang lld make pkgconf file binutils
ARG TARGETPLATFORM
# gcc only for libgcc (the runtime support library, GCC Runtime Library Exception); linux-headers for shadow.
RUN xx-apk add --no-cache musl-dev gcc linux-headers
ENV GOFLAGS=-trimpath GOTOOLCHAIN=local
COPY --from=src /src/runc /src/runc
COPY --from=src /src/shadow /src/shadow
# runc: no `seccomp` tag (libseccomp is LGPL); `apparmor` is runc's own pure-Go profile writer.
RUN --mount=type=cache,target=/go/pkg/mod --mount=type=cache,target=/root/.cache/go-build set -e; \
  cd /src/runc; \
  CGO_ENABLED=1 xx-go build -mod=vendor -ldflags '-s -w -extldflags -static' \
    -tags 'netgo osusergo static_build apparmor' -o /out/runc .; \
  xx-verify --static /out/runc
# shadow: only newuidmap/newgidmap; no PAM, SELinux, audit, ACL, libbsd or nscd (each optional upstream).
RUN set -e; cd /src/shadow; \
  ./configure --quiet --host="$(xx-clang --print-target-triple)" CC=xx-clang \
    --disable-shared --enable-static --disable-nls --disable-logind --disable-syslog \
    --without-audit --without-libpam --without-selinux --without-acl --without-tcb \
    --without-libbsd --without-sssd --without-nscd --without-btrfs --enable-subordinate-ids LDFLAGS=-static >/dev/null; \
  make -s -C lib >/dev/null; make -s -C src newuidmap newgidmap LDFLAGS=-all-static >/dev/null; \
  mkdir -p /out && cp src/newuidmap src/newgidmap /out/ && chmod 0755 /out/newuidmap /out/newgidmap; \
  llvm-strip /out/newuidmap /out/newgidmap 2>/dev/null || true; \
  xx-verify --static /out/newuidmap; xx-verify --static /out/newgidmap

# ---- the root filesystem: users, subordinate ids, empty writable mount points --------------------------------------
FROM --platform=$BUILDPLATFORM ${ALPINE_IMAGE} AS rootfs
# uid 0 is the pod's MAPPED root under `hostUsers: false` (never the node's root). /etc/subuid hands rootlesskit the
# rest of the pod's 65536 ids for the nested namespace buildkitd runs in.
RUN set -e; mkdir -p /rootfs/etc /rootfs/tmp /rootfs/run /rootfs/var/lib/buildkit /rootfs/workspace /rootfs/root; \
  chmod 1777 /rootfs/tmp; \
  printf 'root:x:0:0:root:/root:/nonexistent\nnobody:x:65534:65534:nobody:/nonexistent:/nonexistent\n' > /rootfs/etc/passwd; \
  printf 'root:x:0:\nnobody:x:65534:\n' > /rootfs/etc/group; \
  printf 'root:1:65535\n' > /rootfs/etc/subuid; printf 'root:1:65535\n' > /rootfs/etc/subgid

FROM scratch
COPY --from=rootfs /rootfs/ /
COPY --from=gobuild /out/ /usr/local/bin/
COPY --from=cbuild /out/ /usr/local/bin/
ENV PATH=/usr/local/bin HOME=/root XDG_RUNTIME_DIR=/run
LABEL org.opencontainers.image.source="https://github.com/Data-Masterclass/sovereign-agentic-os" \
      org.opencontainers.image.licenses="Apache-2.0 AND BSD-3-Clause" \
      org.opencontainers.image.description="Sovereign OS app builder: buildkitd, buildctl, runc, rootlesskit, newuidmap/newgidmap, crane, zot-users, require-userns"
ENTRYPOINT ["/usr/local/bin/buildctl"]
