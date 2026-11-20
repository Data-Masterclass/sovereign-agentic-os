# Vega-Lite (and vl-convert, the eject renderer)

Upstream, unmodified. Nothing in this folder is ours — see the rule in `components/README.md`.

- **Licence:** BSD-3-Clause (`gh api repos/vega/vega-lite --jq .license.spdx_id` → `BSD-3-Clause`;
  `gh api repos/vega/vl-convert --jq .license.spdx_id` → `BSD-3-Clause`, 20 Nov 2026)
- **Source:** https://github.com/vega/vega-lite · https://github.com/vega/vl-convert
- **Pinned as:** the FILE FORMAT Vega-Lite **v5** (`$schema: https://vega.github.io/schema/vega-lite/v5.json`),
  validated in CI against the published JSON Schema **v5.21.0**
  (https://vega.github.io/schema/vega-lite/v5.21.0.json). The eject renderer is PyPI
  `vl-convert-python==1.8.0` run with `vl_version="5.21"`, plus `jsonschema==4.23.0` (MIT) for the
  schema check. Neither ships in an OS image: they run only in the CI eject job.
- **Docs used (fetched 20 Nov 2026):**
  - Spec structure, `data.name` (named data sources), `mark`, `encoding`, `transform: fold`:
    https://vega.github.io/vega-lite/docs/spec.html · https://vega.github.io/vega-lite/docs/data.html#named
    · https://vega.github.io/vega-lite/docs/fold.html
  - vl-convert Python API (`vegalite_to_svg`, `vegalite_to_scenegraph`, `get_vegalite_versions`):
    https://github.com/vega/vl-convert/tree/main/vl-convert-python
- **Companion dbt docs** (the numbers of each panel):
  https://docs.getdbt.com/docs/build/saved-queries · https://docs.getdbt.com/docs/build/exposures
  (dbt-core 1.9.11 + dbt-semantic-interfaces 0.7.5 in the chart's Dagster image).

**Why the OS uses it:** a dashboard's native form (artifact contract 11 §3.1, WP-52). Each panel is
a dbt saved query (`dashboards/<slug>/semantic.yml`) and a Vega-Lite v5 spec
(`dashboards/<slug>/panels/<panel>.vl.json`) whose named data source is that saved query. The OS
keeps drawing with Apache ECharts, driven by the spec's mark (`line | area | bar | arc | text`);
it does not bundle Vega or Vega-Lite at run time.

The glue lives in `os-ui/tabs/dashboards/lib/git/native.ts`; the eject proof is
`os-ui/tabs/dashboards/lib/git/native-eject.docker.test.ts`.
