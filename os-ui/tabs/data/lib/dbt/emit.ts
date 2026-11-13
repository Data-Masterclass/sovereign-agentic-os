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

/** Single-quoted SQL/Jinja string literal. */
export function qlit(s: string): string {
  return `'${String(s).replace(/'/g, "''")}'`;
}
