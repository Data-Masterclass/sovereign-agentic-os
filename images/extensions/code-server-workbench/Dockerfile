# Sovereign Agentic OS — Domain-Builder Workbench (code-server / VS Code in browser).
#
# The PERSISTENT, DOMAIN-SCOPED editor a builder works in. Unlike the ephemeral
# terminal sandbox, this image ships a real toolchain (git + python + duckdb + the
# governed `dq` data CLI) so a builder can build/edit/administer ALL their domain's
# artifacts — software repos, agent defs, governed data, knowledge — in one place.
#
# Security posture is the SAME family as the sandbox: always run non-root (uid
# 1000 `coder`), all capabilities dropped, seccomp RuntimeDefault, NO Kubernetes
# token mounted, behind a per-builder NetworkPolicy (ingress only from the broker;
# egress only to its own domain's Forgejo + the governed query-tool). It carries a
# DOMAIN-SCOPED Forgejo token (never the global admin) injected at runtime via the
# per-builder Secret — so it can push to its domain's repos but reach nothing else.
#
# Pinned to a code-server release digest in production; tag-pinned here for the
# local kind prototype.
FROM codercom/code-server:4.96.4

USER root

# git for the software golden path; python3 + duckdb for the data/agent flows;
# curl for the governed `dq` CLI (which talks ONLY to the query-tool via the
# allowed NetworkPolicy path). No kubectl/helm/cloud CLIs: minimise pivot tooling.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates curl jq python3 python3-pip \
 && rm -rf /var/lib/apt/lists/*

# DuckDB CLI (pinned). Downloaded at build time only — the running workbench has
# NO general egress.
ARG DUCKDB_VERSION=v1.1.3
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) zip="duckdb_cli-linux-amd64.zip" ;; \
      arm64) zip="duckdb_cli-linux-aarch64.zip" ;; \
      *) echo "unsupported arch $arch"; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/duckdb/duckdb/releases/download/${DUCKDB_VERSION}/${zip}" -o /tmp/duckdb.zip; \
    apt-get update && apt-get install -y --no-install-recommends unzip; \
    unzip /tmp/duckdb.zip -d /usr/local/bin; \
    chmod +x /usr/local/bin/duckdb; \
    rm -f /tmp/duckdb.zip; \
    apt-get purge -y unzip; apt-get autoremove -y; rm -rf /var/lib/apt/lists/*

# Governed data CLI: `dq "<sql>"` -> POSTs to the query-tool (the SINGLE sanctioned
# data path; domain scope is enforced server-side by the query-tool/OPA). It does
# NOT hold DB creds — it cannot bypass the governed layer.
COPY dq /usr/local/bin/dq
COPY workbench-entrypoint.sh /usr/local/bin/workbench-entrypoint.sh
RUN chmod +x /usr/local/bin/dq /usr/local/bin/workbench-entrypoint.sh

USER 1000
ENV HOME=/home/coder
WORKDIR /home/coder

# Our entrypoint wires the domain-scoped git creds + workspace, then hands off to
# the stock code-server entrypoint with the chart-provided args.
ENTRYPOINT ["/usr/local/bin/workbench-entrypoint.sh"]
