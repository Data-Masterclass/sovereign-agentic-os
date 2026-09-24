# Sovereign Dagster image — arm64-native (official dagster/* images are
# amd64-only). One image serves webserver, daemon, and user-code. Includes
# dbt + dagster-dbt so Dagster orchestrates the dbt warehouse build.
# Build context is images/ (so it can COPY both dagster/ and dbt/).
FROM python:3.12-slim@sha256:6c4dd321d176d61ea848dc8c73a4f7dbae8f70e0ee48bb411ea2f045b599fa8e

# Dagster core 1.13.11; integration libs follow the 0.x scheme (0.29.11).
RUN pip install --no-cache-dir \
      "dagster==1.13.11" \
      "dagster-webserver==1.13.11" \
      "dagster-graphql==1.13.11" \
      "dagster-postgres==0.29.11" \
      "dagster-k8s==0.29.11" \
      "dagster-dbt==0.29.11" \
      "dbt-core>=1.8,<1.10" \
      "dbt-trino>=1.8,<1.10"

RUN mkdir -p /opt/dagster/app /opt/dagster/dagster_home /opt/dbt

# The dbt project + a pre-parsed manifest (dbt parse needs no DB connection).
COPY dbt/project /opt/dbt/project
RUN cd /opt/dbt/project && dbt parse --profiles-dir /opt/dbt/project --target dev || \
    dbt parse --profiles-dir /opt/dbt/project

COPY dagster/repo.py /opt/dagster/app/repo.py
RUN chmod -R a+rX /opt/dagster /opt/dbt

ENV DAGSTER_HOME=/opt/dagster/dagster_home
WORKDIR /opt/dagster/app
