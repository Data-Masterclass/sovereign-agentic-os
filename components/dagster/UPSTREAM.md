# Dagster

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/dagster-io/dagster
- **Pinned as:** Helm chart `dagster` 1.13.11 (https://dagster-io.github.io/helm)

Inside our image `sovereign-os/dagster` (`images/extensions/dagster/Dockerfile`), exact pins:

| Package | Version | Licence | Docs used |
|---|---|---|---|
| dagster, dagster-webserver, dagster-graphql | 1.13.11 | Apache-2.0 | https://docs.dagster.io/ |
| dagster-dbt, dagster-dlt, dagster-k8s, dagster-postgres | 0.29.11 | Apache-2.0 | https://docs.dagster.io/integrations/libraries/dbt |
| dbt-core | 1.9.11 | Apache-2.0 (https://github.com/dbt-labs/dbt-core) | `dbt parse` https://docs.getdbt.com/reference/commands/parse · `dbt compile` https://docs.getdbt.com/reference/commands/compile · targets https://docs.getdbt.com/docs/core/connect-data-platform/connection-profiles |
| dbt-trino | 1.9.3 | Apache-2.0 (https://github.com/starburstdata/dbt-trino) | https://docs.getdbt.com/docs/core/connect-data-platform/trino-setup |
| dlt[sqlalchemy,sql-database], trino[sqlalchemy] | 1.32.0, 0.340.0 | Apache-2.0 | see `components/dlt/UPSTREAM.md` |

`images/extensions/dagster/tests/image/run.sh` reads the dbt versions back from the built image, so
the tests and the eject check always use what the image actually carries.

**Why the OS ships it:** Scheduled syncs and pipelines: SQL sources, OneDrive/Google Drive, dbt models, re-indexing.

Since WP-49 the image owns no asset, job or schedule: `repo.py` is a platform wrapper that loads each domain repo's own
`data/dagster/definitions.py` (Dagster API used: `Definitions`, `Definitions.merge`, `Definitions.validate_loadable`,
`ScheduleDefinition`, `define_asset_job`, `build_last_update_freshness_checks`, `dagster_dbt.DbtProject` / `dbt_assets`;
https://docs.dagster.io/api/dagster/definitions, https://docs.dagster.io/integrations/libraries/dbt/reference).

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.

## Literal safety — what dbt renders (docs used)

The dbt generator (`os-ui/tabs/data/lib/dbt/literal.ts`) relies on these upstream facts, checked in
the image by `images/extensions/dagster/tests/image/literal_safety.py`:

- Model `.sql` files are Jinja templates: https://docs.getdbt.com/docs/build/jinja-macros
- Properties YAML string values are rendered; descriptions are rendered later, in docs processing
  (`doc()` is available there): https://docs.getdbt.com/reference/resource-properties/description ·
  https://docs.getdbt.com/docs/build/documentation · dbt-core 1.9.11 `core/dbt/parser/schema_renderer.py`
  (https://github.com/dbt-labs/dbt-core/blob/v1.9.11/core/dbt/parser/schema_renderer.py)
- A column's `quote: true` makes dbt quote the name with the adapter's quoting:
  https://docs.getdbt.com/reference/resource-properties/quote
- Trino 476 reserved keywords: https://trino.io/docs/476/language/reserved.html · Unicode string
  literals `U&'…'`: https://trino.io/docs/476/language/types.html

