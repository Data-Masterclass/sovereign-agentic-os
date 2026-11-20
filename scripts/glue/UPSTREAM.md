# Upstream pins for the glue-discipline checks (WP-01)

Every tool and schema the glue rules use, pinned. Nothing here is re-implemented: each rule asks the
tool or schema the component publishes.

| What | Version / pin | Licence | Where | Used by |
|---|---|---|---|---|
| dependency-cruiser | 18.7.2 (npm, exact devDependency) | MIT | https://github.com/sverweij/dependency-cruiser — rules reference: `doc/rules-reference.md` | GLUE-1 static imports, GLUE-2 transitive reach, GLUE-9 (`os-ui/.dependency-cruiser.cjs`) |
| TypeScript compiler API | the repo's pinned `typescript` (os-ui devDependency) | Apache-2.0 | https://github.com/microsoft/TypeScript/wiki/Using-the-Compiler-API | the AST of every rule (`scripts/glue/ast.mjs`) |
| ajv | 8.17.1 (npm, exact devDependency) | MIT | https://ajv.js.org/ | GLUE-10 schema validation |
| dbt-jsonschema | commit `6a401244651d3b5e0fd2f7cfcfb120187118edb4` (2026-09-11), `schemas/latest/dbt_yml_files-latest.json` → `schemas/dbt_yml_files.json` (sha256 `80b04ecc…040ba`), `schemas/latest/dbt_project-latest.json` → `schemas/dbt_project.json` (sha256 `a27ea593…eba2`) | Apache-2.0 | https://github.com/dbt-labs/dbt-jsonschema | GLUE-10: unknown keys in generated dbt YAML |
| Vega-Lite JSON schema | vega-lite 5.23.0, `build/vega-lite-schema.json` → `schemas/vega-lite-v5.json.gz` (sha256 of the uncompressed file `1aeeda8a…610e`) | BSD-3-Clause | https://vega.github.io/schema/vega-lite/v5.json | GLUE-10: Vega-Lite panels |
| Python `ast` | the runner's python3 (stdlib) | PSF-2.0 | https://docs.python.org/3/library/ast.html | GLUE-10: generated Dagster Python (`py_kwargs.py`) |
| kubeconform | `ghcr.io/yannh/kubeconform:v0.7.0@sha256:85dbef6b…` (in `validators.json`) | Apache-2.0 | https://github.com/yannh/kubeconform | GLUE-6 |
| dbt, Dagster, Trino, OPA | the chart's own images, read from `charts/sovereign-agentic-os/values.yaml` at run time | Apache-2.0 | https://docs.getdbt.com/reference/commands/parse · https://docs.getdbt.com/reference/commands/compile · https://docs.dagster.io/api/clis/cli#dagster-definitions-validate · https://www.openpolicyagent.org/docs/cli | GLUE-6 / C1 (`scripts/validate-generated.sh`) |

`scripts/glue/contract.mjs` verifies each vendored schema against the sha256 above before it uses it.

## Schema gap patched (documented by dbt, missing in dbt-jsonschema)

- `metrics[].config` (`meta`, `enabled`, `group`, `tags`) and `metrics[].meta`: dbt documents `config`
  on metrics (https://docs.getdbt.com/reference/resource-properties/config). See `SCHEMA_ADDITIONS`
  in `contract.mjs`. Only `additionalProperties` errors outside a `oneOf`/`anyOf` branch count as
  "unknown key"; every other schema error is left to the tool itself (GLUE-6 runs `dbt parse`).
