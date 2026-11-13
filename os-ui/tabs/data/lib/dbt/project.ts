/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    dbt project scaffold — dbt_project.yml, profiles.yml, macros, generic tests, README
 * USER STORY: As a data engineer I want to clone my domain's repo and run `dbt parse` with only
 *             environment variables set — no inlined credentials, the Trino target the OS uses,
 *             and the custom tests the OS's quality rules compile to (checklist D1).
 * ARCHITECTURE:
 *   - Pure renderers. `profiles.yml` uses `env_var()` ONLY; `impersonation_user` =
 *     `env_var('OS_PRINCIPAL')` with NO default — a run without a principal fails loudly rather
 *     than impersonating the domain (concept §3). The sidecar sets a non-entitled principal to parse.
 *   - `generate_schema_name` returns the custom schema verbatim so `+schema: personal_<uid>`
 *     lands in `personal_<uid>`, not `<target>_personal_<uid>` (dbt's default concatenation).
 *   - `tests/generic/range.sql` and `not_blank.sql` carry the predicates of `dq.ts` so the same
 *     row counts as a violation in the OS and in `dbt test`.
 */
import { yml, textFile } from '@tabs/data/lib/dbt/emit';
import { domainSchema } from '@tabs/data/lib/store-fqn';
import type { ModelPlanSet } from '@tabs/data/lib/dbt/models';
import { DBT_SEMANTIC_SPEC } from '@tabs/data/lib/dbt/semantic/spec';
import type { SemanticRender } from '@tabs/data/lib/dbt/semantic/render';
import { TIME_SPINE_MODEL } from '@tabs/data/lib/dbt/semantic/time-spine';

export const PROFILE_NAME = 'sovereign';

/** `dbt_project.yml` — per-layer and per-personal-lane schemas. */
export function renderDbtProject(domain: string, plan: ModelPlanSet): string {
  const name = domainSchema(domain);
  const layers: Record<string, unknown> = {};
  for (const l of plan.layerDirs) {
    layers[l] = {
      '+schema': name,
      ...(l === 'bronze' ? {} : { '+on_table_exists': 'replace' }),
    };
  }
  const personal: Record<string, unknown> = {};
  for (const uid of plan.personalUids) personal[uid] = { '+schema': `personal_${uid}` };
  return yml({
    name,
    version: '1.0.0',
    'config-version': 2,
    profile: PROFILE_NAME,
    'model-paths': ['models'],
    'macro-paths': ['macros'],
    'test-paths': ['tests'],
    'clean-targets': ['target', 'dbt_packages'],
    models: {
      [name]: {
        '+materialized': 'table',
        ...layers,
        ...(plan.personalUids.length ? { personal } : {}),
      },
    },
  });
}

/**
 * `profiles.yml` — Trino target, `env_var()` only, impersonation of the acting principal.
 *
 * The CREDENTIAL (B3-review, "impersonation reality"). `method` defaults to `none`, and Trino with
 * no authenticator has no `original_user` for an impersonation rule to match — so impersonation is
 * inert until an operator turns PASSWORD (or JWT/OAUTH2) authentication on. When they do, dbt-trino
 * needs a `password`, and `TrinoNoneCredentials` would REJECT the key — so the key must be
 * present for one method and ABSENT for the other.
 *
 * WHICH IS A GENERATOR INPUT, NOT A JINJA CONDITION (B4-review E-3). This used to splice a
 * `# {% if env_var('TRINO_AUTH_METHOD') != 'none' %}` guard, as a YAML comment, around the
 * `password:` line, on the belief that dbt renders the whole file through Jinja before parsing the
 * YAML. It does not: dbt loads `profiles.yml` as YAML FIRST and then renders each scalar value
 * through Jinja — so the comment carrying the guard is discarded by the YAML parser and
 * `password:` was present unconditionally, which `method: none` rejects. The generator is now
 * TOLD the method (`config.trinoAuthMethod`, default `none`) and emits `method:` as a literal and
 * `password:` only when it is not `none`. Changing the method takes effect on the next
 * regeneration — any dataset write, or the boot reconcile.
 *
 * Only `env_var()` ever appears as a VALUE: a literal password in a repo anyone in the domain can
 * clone is not a path the generator offers, and with auth on there is no `''` default either — a
 * missing `TRINO_PASSWORD` must fail loudly, not connect as nobody. See
 * docs/components/trino.md -> "Enable real impersonation".
 */
export function renderProfiles(domain: string, trinoAuthMethod: string = 'none'): string {
  const doc = yml({
    [PROFILE_NAME]: {
      target: 'trino',
      outputs: {
        trino: {
          type: 'trino',
          // A literal, not `{{ env_var(...) }}`: it has to agree with whether `password:` below
          // was emitted at all, and only the generator knows that (B4-review E-3).
          method: trinoAuthMethod,
          host: "{{ env_var('TRINO_HOST', 'trino') }}",
          port: "{{ env_var('TRINO_PORT', '8080') | as_number }}",
          user: "{{ env_var('TRINO_USER', 'dbt-runner') }}",
          impersonation_user: "{{ env_var('OS_PRINCIPAL') }}",
          http_scheme: "{{ env_var('TRINO_HTTP_SCHEME', 'http') }}",
          catalog: "{{ env_var('TRINO_CATALOG', 'iceberg') }}",
          schema: domainSchema(domain),
          threads: 4,
        },
      },
    },
  });
  if (trinoAuthMethod === 'none') return doc;
  // Spliced textually (the YAML emitter cannot express a conditional key), after the `user:` line
  // and at its own indentation, so the file stays byte-stable and the generator goldens assert it.
  return doc.replace(
    /^([ \t]*)user: (.*)$/m,
    (_whole, indent: string, value: string) =>
      [`${indent}user: ${value}`, `${indent}password: "{{ env_var('TRINO_PASSWORD') }}"`].join('\n'),
  );
}

export function renderMacros(): Map<string, string> {
  return new Map([
    [
      'macros/generate_schema_name.sql',
      textFile([
        '{#- Sovereign OS: a model\'s +schema is the EXACT Iceberg schema it lands in (personal_<uid> or the',
        '    domain schema) — never dbt\'s default `<target.schema>_<custom>` concatenation. -#}',
        '{% macro generate_schema_name(custom_schema_name, node) -%}',
        '    {%- if custom_schema_name is none -%}',
        '        {{ target.schema }}',
        '    {%- else -%}',
        '        {{ custom_schema_name | trim }}',
        '    {%- endif -%}',
        '{%- endmacro %}',
      ]),
    ],
    [
      'macros/os_maintenance.sql',
      textFile([
        '{#- Sovereign OS Iceberg maintenance: `ALTER TABLE … EXECUTE optimize` + `expire_snapshots` for every',
        '    table / incremental model in `schema` (all schemas when none). Run weekly by the Dagster code',
        '    location as the schema\'s owning principal: `dbt run-operation os_maintenance --args \'{"schema": …}\'`.',
        '    The retention is fixed (Trino\'s default minimum) — nothing user-controlled is interpolated. -#}',
        '{% macro os_maintenance(schema=none) %}',
        '{%- if execute -%}',
        "{%- for node in graph.nodes.values() | selectattr('resource_type', 'equalto', 'model') -%}",
        "{%- if node.config.materialized in ('table', 'incremental') and (schema is none or node.schema == schema) -%}",
        '{%- set rel = adapter.get_relation(database=node.database, schema=node.schema, identifier=node.alias) -%}',
        '{%- if rel is not none -%}',
        '{%- do run_query("alter table " ~ rel ~ " execute optimize") -%}',
        '{%- do run_query("alter table " ~ rel ~ " execute expire_snapshots(retention_threshold => \'7d\')") -%}',
        '{%- do log("os_maintenance: " ~ rel, info=true) -%}',
        '{%- endif -%}',
        '{%- endif -%}',
        '{%- endfor -%}',
        '{%- endif -%}',
        '{% endmacro %}',
      ]),
    ],
  ]);
}

/** The two generic tests the OS quality rules need beyond dbt's built-ins (predicates from dq.ts). */
export function renderGenericTests(): Map<string, string> {
  return new Map([
    [
      'tests/generic/range.sql',
      textFile([
        '{#- Sovereign OS quality rule `range`: a NON-NULL value outside [min, max] is a violation',
        '    (one-sided when only min or max is set). Same predicate as tabs/data/lib/dq.ts. -#}',
        '{% test range(model, column_name, min=none, max=none) %}',
        '{%- if min is none and max is none -%}',
        '  {{ exceptions.raise_compiler_error("range needs a min and/or a max") }}',
        '{%- endif -%}',
        'select *',
        'from {{ model }}',
        'where {{ column_name }} is not null',
        '  and (',
        '    {%- if min is not none %} {{ column_name }} < {{ min }}{% endif -%}',
        '    {%- if min is not none and max is not none %} or{% endif -%}',
        '    {%- if max is not none %} {{ column_name }} > {{ max }}{% endif %}',
        '  )',
        '{% endtest %}',
      ]),
    ],
    [
      'tests/generic/not_blank.sql',
      textFile([
        '{#- Sovereign OS quality rule `not_blank`: NULL or an empty / whitespace-only string is a',
        '    violation. Same predicate as tabs/data/lib/dq.ts. -#}',
        '{% test not_blank(model, column_name) %}',
        'select *',
        'from {{ model }}',
        "where {{ column_name }} is null or trim(cast({{ column_name }} as varchar)) = ''",
        '{% endtest %}',
      ]),
    ],
  ]);
}

export function renderReadme(domain: string, plan: ModelPlanSet, semantic?: SemanticRender): string {
  const models = plan.models.map((m) => `- \`${m.path}\` — ${m.kind}, schema \`${m.schema}\``);
  const metrics = (semantic?.metrics ?? []).map((m) => `- \`${m.name}\` (${m.type}) — OS metric \`${m.osMetric}\`, in \`${m.path}\``);
  const refused = (semantic?.refusals ?? []).map((r) => `- \`${r.measure}\` on OS dataset \`${r.dataset}\` — ${r.reason}`);
  return textFile([
    `# ${domain} — data product (dbt project)`,
    '',
    'Generated by the Sovereign Agentic OS from the domain\'s dataset definitions. The OS is the',
    'writer: every dataset, composition, quality rule, sync or publish change in the UI or through the',
    'OS MCP regenerates this project and commits it as the acting user. Read it, export it, mirror it;',
    'edit the datasets in the OS.',
    '',
    '## Run it',
    '',
    '```sh',
    'export TRINO_HOST=trino TRINO_PORT=8080 TRINO_USER=dbt-runner OS_PRINCIPAL=<your-principal>',
    'dbt parse --profiles-dir .',
    'dbt build --profiles-dir . --select <model>+',
    '```',
    '',
    '`profiles.yml` reads only environment variables. `OS_PRINCIPAL` is the Trino user dbt impersonates;',
    'Trino→OPA governs that identity exactly as the OS UI does. No credential lives in this repository.',
    '',
    '## Layout',
    '',
    '- `models/sources.yml` — Bronze landings and federated tables dbt reads but never writes',
    '- `models/silver/`, `models/gold/` — promoted (domain) layers; `models/personal/<uid>/` — personal lane',
    '- `models/**/schema.yml` — descriptions and the quality rules as tests',
    '- `tests/generic/` — the `range` and `not_blank` tests the OS rules compile to',
    '- `macros/os_maintenance.sql` — weekly Iceberg `optimize` + `expire_snapshots`, run by Dagster per schema',
    '- `os/schedules.yml` — sync schedules (cron, UTC, principal) for the Dagster code location',
    '- `os/external.yml` — sources dbt cannot model (Kafka offsets, API batch); Dagster assets',
    ...(semantic?.files.size
      ? [
          '- `models/semantic/<model>.yml` — the `semantic_models:` + `metrics:` of promoted datasets',
          '  (a personal dataset\'s sit in `models/personal/<uid>/semantic/`; promotion moves the file)',
          ...(semantic.timeSpine ? [`- \`models/os/${TIME_SPINE_MODEL}.sql\` — the daily time spine (a view over \`sequence(...)\`)`] : []),
        ]
      : []),
    '',
    '## Models',
    '',
    ...(models.length ? models : ['_(no built layers yet)_']),
    // The semantic section only exists once a metric does — a project with no metric should not
    // carry a page about the spec version of something it does not have.
    ...(metrics.length || refused.length
      ? [
          '',
          '## Metrics (dbt semantic layer)',
          '',
          `This project targets **one** semantic spec version: \`dbt-semantic-interfaces ${DBT_SEMANTIC_SPEC.dsiVersion}\``,
          `(= dbt-core ${DBT_SEMANTIC_SPEC.dbtCore}); every field emitted is also valid on dbt-core ${DBT_SEMANTIC_SPEC.minDbtCore}, which is what`,
          `the OS images carry today (\`${DBT_SEMANTIC_SPEC.imagePin}\`). The time spine uses the dbt >= 1.9`,
          `\`${DBT_SEMANTIC_SPEC.timeSpineProperty}\` model property, never the legacy \`${DBT_SEMANTIC_SPEC.legacyTimeSpineModel}\` name.`,
          '',
          'Query them with MetricFlow from a clone:',
          '',
          '```sh',
          'mf query --metrics <metric> --group-by metric_time__month',
          '```',
          '',
          ...metrics,
          ...(refused.length
            ? ['', '### Not emitted', '', 'These OS metrics have no faithful form in this spec version, so nothing was written for them:', '', ...refused]
            : []),
        ]
      : []),
  ]);
}

export function renderGitignore(): string {
  return textFile(['target/', 'dbt_packages/', 'logs/']);
}
