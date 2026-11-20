# dlt (data load tool)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/dlt-hub/dlt
- **Pinned as:** Python package inside our Dagster image `sovereign-os/dagster`
  (`images/extensions/dagster/Dockerfile`), exact pins:

| Package | Version | Licence | Docs used |
|---|---|---|---|
| dlt[sqlalchemy,sql-database] | 1.32.0 (released 2026-10-29) | Apache-2.0 | `sql_table` source https://dlthub.com/docs/dlt-ecosystem/verified-sources/sql_database · `sqlalchemy` destination https://dlthub.com/docs/dlt-ecosystem/destinations/sqlalchemy · incremental loading https://dlthub.com/docs/general-usage/incremental-loading · config and secrets from the environment https://dlthub.com/docs/general-usage/credentials/setup · running in Dagster https://dlthub.com/docs/walkthroughs/deploy-a-pipeline/deploy-with-dagster |
| dagster-dlt (`@dlt_assets`, `DagsterDltResource`, `DagsterDltTranslator`) | 0.29.11 (matches dagster 1.13.11) | Apache-2.0 | https://docs.dagster.io/integrations/libraries/dlt |
| trino[sqlalchemy] (trino-python-client) | 0.340.0 | Apache-2.0 | SQLAlchemy dialect https://github.com/trinodb/trino-python-client#sqlalchemy |

**Why the OS ships it:** Bronze ingestion of database sources runs as dlt inside Dagster (design 01
M5, decision O8, WP-49). The generated `data/dagster/definitions.py` of a domain repo defines one
`@dlt_assets` (dagster-dlt) per database sync over a dlt source: at load time a credential-free
declaration of the landing resource, in the run `sql_table(credentials=…)` passed to
`DagsterDltResource.run(dlt_source=…)`. The destination is
dlt's `sqlalchemy` destination over Trino's own SQLAlchemy dialect, so the landing is a Trino write
into Iceberg as the run's principal (`landing_<domain>_<owner>.raw_<slug>`). Verified against
Trino 476 with an Iceberg JDBC catalog in `images/extensions/dagster/tests/image/lakehouse.sh`.

Credentials come only from dlt's documented environment configuration
(`SOURCES__<CONNECTION>__CREDENTIALS`, `DESTINATION__SQLALCHEMY__CREDENTIALS__*`), never from a file
in the repo.
