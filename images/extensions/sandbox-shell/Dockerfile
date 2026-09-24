# Sovereign Agentic OS — Terminal Sandbox Shell.
#
# The locked-down teaching image a student's in-UI terminal drops into. It ships
# ONLY the teaching toolset (python3 + duckdb; dbt + the governed query CLI are
# additive — see the comment block below) and deliberately NOTHING that helps an
# attacker pivot: no kubectl, no helm, no cloud CLIs, no docker, no sudo, no
# package manager left wired for privilege gain. It is always run non-root with a
# read-only root filesystem, all capabilities dropped, seccomp RuntimeDefault,
# and no ServiceAccount token mounted (the Pod spec enforces this), behind a
# deny-egress NetworkPolicy. This image is the LAST line of defence, not the
# first — the Pod securityContext + NetworkPolicy are.
FROM python:3.12-slim-bookworm AS base

# bash for a friendly teaching shell; ca-certificates so the *governed* data
# endpoints (reached only through the allowed NetworkPolicy path) present valid
# TLS. No curl/wget/netcat/ssh/git: minimise the lateral-movement toolkit.
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Teaching libraries. duckdb (python module + bundled engine) is the core.
# dbt-core / dbt-duckdb and the governed query CLI are intentionally LEFT OUT of
# this prototype image to keep the build fast; add them here for the real image:
#   RUN pip install --no-cache-dir dbt-core dbt-duckdb
RUN pip install --no-cache-dir duckdb==1.1.3

# The DuckDB standalone CLI (handy for teaching `duckdb` at the prompt). Pinned.
# (Downloaded at build time only; the running sandbox has NO egress.)
ARG DUCKDB_VERSION=v1.1.3
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) zip="duckdb_cli-linux-amd64.zip" ;; \
      arm64) zip="duckdb_cli-linux-aarch64.zip" ;; \
      *) echo "unsupported arch $arch"; exit 1 ;; \
    esac; \
    apt-get update && apt-get install -y --no-install-recommends curl unzip; \
    curl -fsSL "https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/${zip}" -o /tmp/duckdb.zip; \
    unzip /tmp/duckdb.zip -d /usr/local/bin; \
    chmod +x /usr/local/bin/duckdb; \
    rm -f /tmp/duckdb.zip; \
    apt-get purge -y curl unzip; \
    apt-get autoremove -y; \
    rm -rf /var/lib/apt/lists/*

# Non-root teaching user (uid/gid 1000). Home is an emptyDir at runtime.
RUN groupadd -g 1000 sandbox \
 && useradd -m -u 1000 -g 1000 -s /bin/bash sandbox

# A friendly login banner that states the rules.
COPY motd.txt /etc/motd
RUN printf '\ncat /etc/motd\n' >> /etc/bash.bashrc

USER 1000
WORKDIR /home/sandbox
ENV HOME=/home/sandbox \
    PATH=/usr/local/bin:/usr/bin:/bin \
    PYTHONUNBUFFERED=1

CMD ["/bin/bash"]
