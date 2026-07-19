# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
#
# Devcontainer image for Sovereign Agentic OS builders: Go 1.22 (to build/run the
# `sos` CLI), Node 20 (to build/run os-ui), and the small toolchain a builder needs
# (git, jq, helm, kubectl). The `sos` binary is prebuilt at image-build time so the
# container comes up with `sos` already on PATH.
#
# Pinned to the official Go image (Debian bookworm) so the Go toolchain matches the
# CLI's go.mod (go 1.22) exactly and cross-compiles cleanly.
FROM golang:1.22-bookworm

ARG NODE_MAJOR=20

# --- Base OS tooling ---------------------------------------------------------
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      git \
      jq \
      unzip \
      gnupg \
    && rm -rf /var/lib/apt/lists/*

# --- Node.js (for os-ui) -----------------------------------------------------
RUN curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# --- kubectl + helm (for `sos install` orchestration) ------------------------
RUN curl -fsSL https://get.helm.sh/helm-v3.16.3-linux-amd64.tar.gz \
      | tar -xz --strip-components=1 -C /usr/local/bin linux-amd64/helm \
    && curl -fsSL -o /usr/local/bin/kubectl \
      "https://dl.k8s.io/release/v1.30.3/bin/linux/amd64/kubectl" \
    && chmod +x /usr/local/bin/kubectl

# --- Prebuild the sos CLI ----------------------------------------------------
# Copy only the CLI module first so this layer caches on go.mod/go.sum changes.
WORKDIR /opt/sos-src
COPY cli/sos/go.mod cli/sos/go.sum ./
RUN go mod download
COPY cli/sos/ ./
RUN go build -trimpath -ldflags "-s -w -X main.version=devcontainer" -o /usr/local/bin/sos . \
    && sos --version

# A non-root user is provided by the base image? No — create a stable dev user so
# the workspace and caches aren't owned by root.
ARG USERNAME=builder
ARG USER_UID=1000
ARG USER_GID=1000
RUN groupadd --gid ${USER_GID} ${USERNAME} \
    && useradd --uid ${USER_UID} --gid ${USER_GID} -m ${USERNAME}
USER ${USERNAME}
WORKDIR /workspaces
