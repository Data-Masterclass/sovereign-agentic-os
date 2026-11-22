# Sovereign Dagster image — arm64-native (official dagster/* images are
# amd64-only). One image serves webserver, daemon, and user-code. Includes
# dbt + dagster-dbt so Dagster orchestrates the dbt warehouse build.
# Build context is images/ (so it can COPY both dagster/ and dbt/).
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e

# Dagster core 1.13.31; integration libs follow the 0.x scheme (0.29.31) (01 M4, WP-17).
# dbt FLOOR 1.9, not 1.8 (night-2 review M-1): the OS's generated semantic layer emits
# `cumulative_type_params`, dimension `type_params.time_granularity` and the `time_spine` model
# property, none of which exist in dbt-semantic-interfaces 0.5.x (dbt 1.8) — there the generated
# project fails `dbt parse` for the WHOLE domain, taking every dataset's models with it.
# Asserted by scripts/metricflow-floor.mjs, which the licence gate runs.
RUN pip install --no-cache-dir \
      "dagster==1.13.31" \
      "dagster-webserver==1.13.31" \
      "dagster-graphql==1.13.31" \
      "dagster-postgres==0.29.31" \
      # The slim base ships NO Postgres driver, so the webserver and daemon crashed on
      # boot (the "0 runs in 90 days" of the audit). The driver set below is the one that
      # ran 0.2.0 in production for weeks: psycopg2 + SQLAlchemy 2.0. Do NOT add psycopg
      # (v3) and do NOT let SQLAlchemy float to 2.1: with both present SQLAlchemy 2.1 picks
      # the psycopg3 dialect and dagster-webserver 1.13's startup telemetry query
      # (`instance_info.run_storage_id`) dies with "the connection is closed" — the 0.3.0
      # webserver crash-looped on exactly that while the daemon, which never makes that
      # call, ran fine.
      "psycopg2-binary>=2.9" \
      "SQLAlchemy>=2.0,<2.1" \
      "dagster-k8s==0.29.31" \
      "dagster-dbt==0.29.31" \
      # dagster-dlt: the native `@dlt_assets` integration the generated definitions use (WP-49).
      "dagster-dlt==0.29.31" \
      # Exact pins: a range let a rebuild change the dbt that judges every domain; the image tests
      # and the eject test (tests/image/) read these versions back from the image instead of repeating them.
      "dbt-core==1.12.7" \
      "dbt-trino==1.12.0" \
      # MetricFlow and its `mf` CLI (both Apache-2.0; metricflow is Apache-2.0 from 0.209.0, every
      # earlier release is BSL 1.1 and refused by scripts/metricflow-floor.mjs). Master plan O10
      # pins >= 0.213. dbt-metricflow 0.16.0 requires dbt-core >=1.11,<1.13 and metricflow==0.214.0.
      "dbt-metricflow[dbt-trino]==0.16.0" \
      "metricflow==0.214.0" \
      # WP-49: dlt runs the Bronze ingestion inside Dagster (design 01 M5, decision O8): the
      # `sql_database` source for database connections and the `sqlalchemy` destination over
      # Trino's own SQLAlchemy dialect, so a landing is a Trino write as the run's principal into
      # Iceberg. Exact pins (dlt 1.32.0 released 2026-10-29); licences in components/dlt/UPSTREAM.md.
      "dlt[sqlalchemy,sql-database]==1.32.0" \
      "trino[sqlalchemy]==0.340.0"

# git (GPL-2.0, a separate process from a distro package — not linked) for the repo-sync
# sidecar (engine rebuild B1): fetch each domain's generated dbt project from the OS's
# read-only git daemon and `dbt parse` it before Dagster loads it.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/dagster/app /opt/dagster/dagster_home /repos-checkout

# The `sovereign` code location is a PLATFORM WRAPPER only (WP-49): repo.py loads each domain
# repo's own `data/dagster/definitions.py` from repo-sync's checkout and adds the platform's
# sensors and run tags. The image carries no asset, job or schedule of its own.
COPY dagster/repo.py /opt/dagster/app/repo.py
COPY dagster/os_projects.py /opt/dagster/app/os_projects.py
COPY dagster/os_alerts.py /opt/dagster/app/os_alerts.py
COPY dagster/os_files_sync.py /opt/dagster/app/os_files_sync.py
COPY dagster/repo-sync.sh /opt/dagster/app/repo-sync.sh
RUN chmod -R a+rX /opt/dagster && chmod a+x /opt/dagster/app/repo-sync.sh && chmod a+rwX /repos-checkout

ENV DAGSTER_HOME=/opt/dagster/dagster_home
WORKDIR /opt/dagster/app
