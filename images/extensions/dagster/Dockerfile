# Sovereign Dagster image — arm64-native (official dagster/* images are
# amd64-only). One image serves webserver, daemon, and user-code. Includes
# dbt + dagster-dbt so Dagster orchestrates the dbt warehouse build.
# Build context is images/ (so it can COPY both dagster/ and dbt/).
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e

# Dagster core 1.13.11; integration libs follow the 0.x scheme (0.29.11).
# dbt FLOOR 1.9, not 1.8 (night-2 review M-1): the OS's generated semantic layer emits
# `cumulative_type_params`, dimension `type_params.time_granularity` and the `time_spine` model
# property, none of which exist in dbt-semantic-interfaces 0.5.x (dbt 1.8) — there the generated
# project fails `dbt parse` for the WHOLE domain, taking every dataset's models with it.
# Asserted by scripts/metricflow-floor.mjs, which the licence gate runs.
RUN pip install --no-cache-dir \
      "dagster==1.13.11" \
      "dagster-webserver==1.13.11" \
      "dagster-graphql==1.13.11" \
      "dagster-postgres==0.29.11" \
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
      "dagster-k8s==0.29.11" \
      "dagster-dbt==0.29.11" \
      "dbt-core>=1.9,<1.10" \
      "dbt-trino>=1.9,<1.10"

# git (GPL-2.0, a separate process from a distro package — not linked) for the repo-sync
# sidecar (engine rebuild B1): fetch each domain's generated dbt project from the OS's
# read-only git daemon and `dbt parse` it before Dagster loads it.
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/dagster/app /opt/dagster/dagster_home /opt/dbt /repos-checkout

# The dbt project + a pre-parsed manifest (dbt parse needs no DB connection).
COPY dbt/project /opt/dbt/project
RUN cd /opt/dbt/project && dbt parse --profiles-dir /opt/dbt/project --target dev || \
    dbt parse --profiles-dir /opt/dbt/project

# The `sovereign` code location (engine rebuild B2): repo.py wires Dagster; os_projects.py is the
# pure loader (discovery, os/schedules.yml, tags, quarantine) unit-tested in dagster/tests/.
COPY dagster/repo.py /opt/dagster/app/repo.py
COPY dagster/os_projects.py /opt/dagster/app/os_projects.py
COPY dagster/repo-sync.sh /opt/dagster/app/repo-sync.sh
RUN chmod -R a+rX /opt/dagster /opt/dbt && chmod a+x /opt/dagster/app/repo-sync.sh && chmod a+rwX /repos-checkout

ENV DAGSTER_HOME=/opt/dagster/dagster_home
WORKDIR /opt/dagster/app
