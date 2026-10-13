#!/usr/bin/env bash
# Creates the langfuse and litellm databases, each owned by its own role.
# Runs once, on first pg-rw init (postgres image convention: every *.sh under
# /docker-entrypoint-initdb.d/ runs on first boot only; an existing data
# volume skips this).
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    CREATE ROLE "${LANGFUSE_DB_USER}" WITH LOGIN PASSWORD '${LANGFUSE_DB_PASSWORD}';
    CREATE DATABASE langfuse OWNER "${LANGFUSE_DB_USER}";

    CREATE ROLE "${LITELLM_DB_USER}" WITH LOGIN PASSWORD '${LITELLM_DB_PASSWORD}';
    CREATE DATABASE litellm OWNER "${LITELLM_DB_USER}";
EOSQL
