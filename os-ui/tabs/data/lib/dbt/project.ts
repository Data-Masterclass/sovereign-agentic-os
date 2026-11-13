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
 * needs a `password`, and `TrinoNoneCredentials` would REJECT the key — so the line is emitted
 * inside a Jinja guard rather than always. dbt renders `profiles.yml` through Jinja BEFORE parsing
 * the YAML, so the guard is evaluated and the key simply is not there under `method: none`.
 *
 * The guard is written as a YAML COMMENT (`# {% if … %}`) on purpose. Jinja does not know it is
 * looking at YAML, so the block still controls the `password:` line; but the file ALSO has to be
 * valid YAML before rendering, because the generator's own gate parses every emitted `.yml`
 * (`generate.test.ts` "valid yaml and no secrets") and a reader should be able to open it. A bare
 * `{% if %}` line is a YAML flow-collection error. Rendered, the guard leaves an empty comment
 * line either way.
 *
 * Only `env_var()` ever appears: a literal password in a repo anyone in the domain can clone is
 * not a path the generator offers. See docs/components/trino.md -> "Enable real impersonation".
 */
export function renderProfiles(domain: string): string {
  const doc = yml({
    [PROFILE_NAME]: {
      target: 'trino',
      outputs: {
        trino: {
          type: 'trino',
          method: "{{ env_var('TRINO_AUTH_METHOD', 'none') }}",
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
  // Spliced textually (the YAML emitter cannot express a conditional key), after the `user:` line
  // and at its own indentation, so the file stays byte-stable and the generator goldens assert it.
  return doc.replace(
    /^([ \t]*)user: (.*)$/m,
    (_whole, indent: string, value: string) =>
      [
        `${indent}user: ${value}`,
        `${indent}# {% if env_var('TRINO_AUTH_METHOD', 'none') != 'none' %}`,
        `${indent}password: "{{ env_var('TRINO_PASSWORD', '') }}"`,
        `${indent}# {% endif %}`,
      ].join('\n'),
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

export function renderReadme(domain: string, plan: ModelPlanSet): string {
  const models = plan.models.map((m) => `- \`${m.path}\` — ${m.kind}, schema \`${m.schema}\``);
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
    '',
    '## Models',
    '',
    ...(models.length ? models : ['_(no built layers yet)_']),
  ]);
}

export function renderGitignore(): string {
  return textFile(['target/', 'dbt_packages/', 'logs/']);
}
