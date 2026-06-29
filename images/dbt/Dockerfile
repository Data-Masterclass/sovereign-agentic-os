# dbt Core + dbt-trino (both Apache 2.0). Base pinned by digest (python 3.12-slim).
# SINGLE governed adapter: staging -> marts materialize as Iceberg via the central
# Trino engine (Polaris REST catalog). No dbt-duckdb / dbt-postgres on the governed
# path — one engine, one SQL dialect.
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e

RUN pip install --no-cache-dir "dbt-core>=1.8,<1.10" "dbt-trino>=1.8,<1.10"

RUN useradd -u 1000 -m app
COPY --chown=1000:1000 project /opt/dbt/project
USER 1000

ENV DBT_PROFILES_DIR=/opt/dbt/project HOME=/tmp
WORKDIR /opt/dbt/project
ENTRYPOINT ["dbt"]
