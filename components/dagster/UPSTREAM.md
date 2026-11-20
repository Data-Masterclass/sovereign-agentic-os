# Dagster

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/dagster-io/dagster
- **Pinned as:** Helm chart `dagster` 1.13.11 (https://dagster-io.github.io/helm)

Inside our image `sovereign-os/dagster` (`images/extensions/dagster/Dockerfile`), exact pins:

| Package | Version | Licence | Docs used |
|---|---|---|---|
| dagster, dagster-webserver, dagster-graphql | 1.13.11 | Apache-2.0 | https://docs.dagster.io/ |
| dagster-dbt, dagster-k8s, dagster-postgres | 0.29.11 | Apache-2.0 | https://docs.dagster.io/integrations/libraries/dbt |
| dbt-core | 1.9.11 | Apache-2.0 (https://github.com/dbt-labs/dbt-core) | `dbt parse` https://docs.getdbt.com/reference/commands/parse · `dbt compile` https://docs.getdbt.com/reference/commands/compile · targets https://docs.getdbt.com/docs/core/connect-data-platform/connection-profiles |
| dbt-trino | 1.9.3 | Apache-2.0 (https://github.com/starburstdata/dbt-trino) | https://docs.getdbt.com/docs/core/connect-data-platform/trino-setup |

`images/extensions/dagster/tests/image/run.sh` reads the dbt versions back from the built image, so
the tests and the eject check always use what the image actually carries.

**Why the OS ships it:** Scheduled syncs and pipelines: SQL sources, OneDrive/Google Drive, dbt models, re-indexing.

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.
