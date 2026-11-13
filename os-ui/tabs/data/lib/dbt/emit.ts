/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Byte-stable emitters for the generated dbt project (YAML + SQL files)
 * USER STORY: As an engineer diffing two commits of my domain repo I want only real changes to
 *             show up — never reordered keys, drifting quotes or a trailing-newline dance.
 * ARCHITECTURE:
 *   - One `yml()` for every YAML file: insertion-ordered keys (callers build objects in a fixed
 *     order), unlimited line width, double quotes so Jinja (`{{ env_var(...) }}`) reads cleanly,
 *     no anchors. One `sqlFile()` that joins lines with `\n` and ends with exactly one newline.
 *   - No timestamps, no random ids — anything that varies per run is a bug (checklist D3).
 *   - `stripJinja` is the ONE place authored text is made inert before it is emitted: dbt renders
 *     both YAML and SQL as Jinja, so every generator that writes a user string goes through it.
 */
import yaml from 'js-yaml';

/** Deterministic YAML (insertion-ordered keys, double-quoted strings where quoting is needed). */
export function yml(doc: unknown): string {
  return yaml.dump(doc, { lineWidth: -1, noRefs: true, quotingType: '"', forceQuotes: false, sortKeys: false });
}

/** Join lines; exactly one trailing newline. */
export function textFile(lines: string[]): string {
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

/** A safe, double-quoted SQL identifier (strips any embedded double quote). */
export function qident(name: string): string {
  return `"${String(name).replace(/"/g, '')}"`;
}

/**
 * Remove Jinja from an AUTHORED string before it is emitted into the generated project.
 *
 * `dbt parse` renders every `.yml` AND every `.sql` in the project through Jinja before reading it
 * — a SQL comment is no shelter — so an authored description, dataset name or column name reading
 * `{{ env_var('AGENT_RUNTIME_TOKEN') }}` would be EVALUATED in the parsing pod and land in
 * `target/manifest.json`, which the OS reads back. Review B2-review-H3.
 *
 * Stripping, not escaping and not `{% raw %}` (which protects neither a quoted YAML scalar nor a
 * `--` comment): prose has no business being a template, so the author loses nothing real and the
 * result is inert in every context the generator writes.
 */
export function stripJinja(text: string): string {
  return String(text ?? '').replace(/\{\{|\}\}|\{%|%\}|\{#|#\}/g, '');
}

/** Single-quoted SQL/Jinja string literal. */
export function qlit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}
