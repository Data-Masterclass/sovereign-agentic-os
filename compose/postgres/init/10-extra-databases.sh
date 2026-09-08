#!/usr/bin/env bash
# Layer A (docker compose) — provisions the two databases the LiteLLM slice
# needs, mirroring charts/sovereign-agentic-os/values.yaml's `postgres` block
# (top-level database "langfuse" + extraDatabases entry "litellm"), each owned
# by its own role. Runs once, on first pg-rw init (official postgres image
# convention: every *.sh under /docker-entrypoint-initdb.d/ is executed against
# POSTGRES_USER/POSTGRES_DB on first boot only — an existing data volume skips
# this entirely).
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE "${LANGFUSE_DB_USER}" WITH LOGIN PASSWORD '${LANGFUSE_DB_PASSWORD}';
    CREATE DATABASE langfuse OWNER "${LANGFUSE_DB_USER}";

    CREATE ROLE "${LITELLM_DB_USER}" WITH LOGIN PASSWORD '${LITELLM_DB_PASSWORD}';
    CREATE DATABASE litellm OWNER "${LITELLM_DB_USER}";
EOSQL
