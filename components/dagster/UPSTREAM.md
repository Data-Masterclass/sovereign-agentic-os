# Dagster

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** Apache-2.0
- **Source:** https://github.com/dagster-io/dagster
- **Pinned as:** Helm chart `dagster` 1.13.11 (https://dagster-io.github.io/helm)

Inside our image `sovereign-os/dagster` (`images/extensions/dagster/Dockerfile`), exact pins:

| Package | Version | Licence | Docs used |
|---|---|---|---|
| dagster, dagster-webserver, dagster-graphql | 1.13.31 | Apache-2.0 | https://docs.dagster.io/ |
| dagster-dbt, dagster-dlt, dagster-k8s, dagster-postgres | 0.29.31 | Apache-2.0 | https://docs.dagster.io/integrations/libraries/dbt |
| dbt-core | 1.12.7 | Apache-2.0 (https://github.com/dbt-labs/dbt-core) | `dbt parse` https://docs.getdbt.com/reference/commands/parse · `dbt compile` https://docs.getdbt.com/reference/commands/compile · targets https://docs.getdbt.com/docs/core/connect-data-platform/connection-profiles |
| dbt-trino | 1.12.0 | Apache-2.0 (https://github.com/starburstdata/dbt-trino) | https://docs.getdbt.com/docs/core/connect-data-platform/trino-setup |
| metricflow | 0.214.0 | Apache-2.0 from 0.209.0 (https://github.com/dbt-labs/metricflow; 0.208.1 and earlier are BSL 1.1 and refused by `scripts/metricflow-floor.mjs`) | semantic layer https://docs.getdbt.com/docs/build/about-metricflow · dbt-core 1.12 depends on it (`metricflow>=0.213.0`) and reads the semantic layer through its `metricflow_semantic_interfaces` |
| dbt-metricflow[dbt-trino] | 0.16.0 | Apache-2.0 from 0.11.0 (0.10.x and earlier BUSL-1.1, PyPI) | the `mf` CLI: `mf validate-configs`, `mf query` https://docs.getdbt.com/docs/build/metricflow-commands |
| dlt[sqlalchemy,sql-database], trino[sqlalchemy] | 1.32.0, 0.340.0 | Apache-2.0 | see `components/dlt/UPSTREAM.md` |

`images/extensions/dagster/tests/image/run.sh` reads the dbt versions back from the built image, so
the tests and the eject check always use what the image actually carries. `tests/image/test_metricflow.py`
checks MetricFlow's floor and licence from its own package metadata and runs `mf validate-configs` on the
semantic manifest plain dbt wrote (WP-17, 01 M4). The Helm chart stays at 1.13.11 until the 0.4.0 image
is built and pinned; both move together.

**Why the OS ships it:** Scheduled syncs and pipelines: SQL sources, OneDrive/Google Drive, dbt models, re-indexing.

Since WP-49 the image owns no asset, job or schedule: `repo.py` is a platform wrapper that loads each domain repo's own
`data/dagster/definitions.py` (Dagster API used: `Definitions`, `Definitions.merge`, `Definitions.validate_loadable`,
`ScheduleDefinition`, `define_asset_job`, `build_last_update_freshness_checks`, `dagster_dbt.DbtProject` / `dbt_assets`;
https://docs.dagster.io/api/dagster/definitions, https://docs.dagster.io/integrations/libraries/dbt/reference).

The deployment that uses this pin lives in the chart
(`charts/sovereign-agentic-os/templates/`); any glue we wrote belongs there or in the
owning tab, never here.

## Metric alerts (WP-50) — docs used
- An alert is a dbt saved query (`metrics/alerts/<name>.yml`, https://docs.getdbt.com/docs/build/saved-queries)
  with the threshold in its `config.meta` (https://docs.getdbt.com/reference/resource-configs/meta).
- `mf query --saved-query <name> --csv <file>` runs it (https://docs.getdbt.com/docs/build/metricflow-commands).
  `mf` reads `target/semantic_manifest.json`, so `os_alerts.py` runs `dbt parse` first (observed on 0.214.0 /
  dbt-metricflow 0.16.0: without the artifact `mf` refuses with "Unable to load the semantic manifest").
- The OS-launched job per alert outputs `os_alert_result` as Dagster JSON metadata
  (https://docs.dagster.io/api/dagster/metadata), read through `runOrError.eventConnection` (Dagster GraphQL).

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


## Run-pod shape (ValidatingAdmissionPolicy)
- Kubernetes ValidatingAdmissionPolicy, `admissionregistration.k8s.io/v1` (GA since 1.30; STACKIT runs 1.35):
  https://kubernetes.io/docs/reference/access-authn-authz/validating-admission-policy/ — CEL with optional
  map access (`m[?'key'].orValue(...)`), `matchConditions` on `request.userInfo.username`.
- The run pod's labels are dagster-k8s's own (`get_common_labels`, `component="run_worker"`, `dagster/*`;
  dagster_k8s/job.py and launcher.py at 1.13.11) plus the chart's `podTemplateSpecMetadata`.
- Chart: `templates/extensions/dagster/run-pod-admission.yaml`, values `dagsterPodAdmission`.
