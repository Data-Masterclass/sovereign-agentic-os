#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling (licence gate)
 * FEATURE:    Version floors the gate enforces — `metricflow >= 0.209.0` (a LICENCE floor) and
 *             `dbt-core >= 1.9` (a CORRECTNESS floor for the generated semantic layer)
 * USER STORY: As a maintainer I want a pin of `metricflow <= 0.208.1` to FAIL the licence gate,
 *             because those releases are Business Source License 1.1 and the BSL's Additional Use
 *             Grant excludes exactly this product's use — and BSL does not relax retroactively, so
 *             the relicensing to Apache-2.0 at v0.209.0 is NOT backdated (checklist M14).
 * ARCHITECTURE:
 *   - Pure + a CLI. `checkMetricflowFloor(entries)` takes `{path, text}` pairs and returns the
 *     violations; the CLI scans the trees where a Python dependency can enter an image. No network,
 *     no pip, no node_modules.
 *   - A pin is a VIOLATION unless its lower bound is >= the floor. That means an UNPINNED
 *     `metricflow` is a violation too: pip would happily resolve a BSL release, and "we did not
 *     mean to" is not a licence position. `dbt-metricflow` (the extras package) counts the same.
 *   - `licenses/denied-licenses.txt` already denies `BUSL`/`BSL-1.1` by SPDX id; this is the second
 *     half, because a pip specifier carries no SPDX id for the deny list to match.
 *   - The dbt-core floor (night-2 review M-1) is not a licence rule but it lives here because it is
 *     the same question — "can a pin let something unacceptable into a build?" — and the same scan
 *     answers it. The OS's generated semantic layer emits `cumulative_type_params`, dimension
 *     `type_params.time_granularity` and the `time_spine` model property; none exist in
 *     dbt-semantic-interfaces 0.5.x (dbt 1.8), where the generated project fails `dbt parse` for
 *     the WHOLE domain. So dbt 1.8 must not be installable, and that is checkable, not hopeable.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The first Apache-2.0 release. Everything at or below 0.208.1 is BSL 1.1, for ever. */
export const METRICFLOW_FLOOR = '0.209.0';

/**
 * The lowest dbt-core the generated semantic layer parses on. Must equal
 * `DBT_SEMANTIC_SPEC.minDbtCore` in `os-ui/tabs/data/lib/dbt/semantic/spec.ts`, which the suite
 * asserts — two numbers that must agree are one number with two homes, so the test pins both.
 */
export const DBT_CORE_FLOOR = '1.9';

/** Files a Python dependency can enter an image through. */
const SCANNED = /(?:Dockerfile[^/]*|requirements[^/]*\.txt|pyproject\.toml|constraints[^/]*\.txt|Pipfile|environment\.ya?ml)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.next', 'target', 'dbt_packages', '.venv']);

/** Every `metricflow`/`dbt-metricflow` mention with its version specifier, if any. */
// The trailing `(?![\w-])` matters: without it `scripts/metricflow-floor.mjs` in a COMMENT reads
// as an unpinned `metricflow` dependency, and the gate denies its own filename.
const PIN_RE = /(?<![\w-])(dbt-metricflow|metricflow)(?![\w-])(\[[^\]]*\])?[ \t]*((?:[<>=!~]=?[ \t]*[^\s"',;]+[ \t]*,?[ \t]*)*)/gi;

/** Every `dbt-core` mention with its version specifier, if any. */
const DBT_PIN_RE = /(?<![\w-])(dbt-core)(?![\w-])[ \t]*((?:[<>=!~]=?[ \t]*[^\s"',;]+[ \t]*,?[ \t]*)*)/gi;

function cmp(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Check one set of files. Returns `{path, spec, reason}` for every violation.
 *
 * `entries` is `{path, text}[]`. A file with no MetricFlow mention contributes nothing, so an
 * absent MetricFlow passes — which is today's state and must stay a pass, not a silent skip.
 */
export function checkMetricflowFloor(entries) {
  const violations = [];
  for (const { path, text } of entries) {
    for (const m of String(text).matchAll(PIN_RE)) {
      const pkg = m[1];
      const spec = (m[3] ?? '').trim().replace(/,$/, '');
      if (!spec) {
        violations.push({
          path,
          spec: pkg,
          reason: `'${pkg}' is UNPINNED — pip may resolve a BSL 1.1 release (<= 0.208.1). Pin '${pkg} >= ${METRICFLOW_FLOOR}'.`,
        });
        continue;
      }
      // The lower bound is what decides the licence: `>= X` or `== X` or `~= X`.
      const lower = [...spec.matchAll(/(>=|==|~=|>)\s*([0-9][0-9A-Za-z.\-+]*)/g)].map((x) => ({ op: x[1], v: x[2] }));
      if (!lower.length) {
        violations.push({
          path,
          spec: `${pkg} ${spec}`,
          reason: `'${pkg} ${spec}' sets no lower bound, so a BSL 1.1 release (<= 0.208.1) satisfies it. Add '>= ${METRICFLOW_FLOOR}'.`,
        });
        continue;
      }
      const lowest = lower.reduce((acc, x) => (cmp(x.v, acc.v) < 0 ? x : acc));
      const ok = cmp(lowest.v, METRICFLOW_FLOOR) > 0 || (cmp(lowest.v, METRICFLOW_FLOOR) === 0 && lowest.op !== '>');
      if (!ok) {
        violations.push({
          path,
          spec: `${pkg} ${spec}`,
          reason: `'${pkg} ${spec}' allows ${lowest.v}, which is Business Source License 1.1 (<= 0.208.1). The floor is >= ${METRICFLOW_FLOOR}, the first Apache-2.0 release; BSL does not relax retroactively.`,
        });
      }
    }
  }
  return violations;
}

/**
 * The dbt-core floor. Same shape as {@link checkMetricflowFloor}: an unpinned or
 * upper-bound-only `dbt-core` is a violation, because pip would resolve 1.8 and the generated
 * semantic layer does not parse there.
 */
export function checkDbtCoreFloor(entries) {
  const violations = [];
  for (const { path, text } of entries) {
    for (const m of String(text).matchAll(DBT_PIN_RE)) {
      const spec = (m[2] ?? '').trim().replace(/,$/, '');
      const why = `the generated semantic layer emits cumulative_type_params, type_params.time_granularity and the time_spine model property, none of which exist on dbt 1.8 (DSI 0.5.x) — the project would fail \`dbt parse\` for the whole domain`;
      if (!spec) {
        violations.push({ path, spec: 'dbt-core', reason: `'dbt-core' is UNPINNED — pip may resolve 1.8. Pin '>= ${DBT_CORE_FLOOR}'. Why: ${why}.` });
        continue;
      }
      const lower = [...spec.matchAll(/(>=|==|~=|>)[ \t]*([0-9][0-9A-Za-z.\-+]*)/g)].map((x) => ({ op: x[1], v: x[2] }));
      if (!lower.length) {
        violations.push({ path, spec: `dbt-core ${spec}`, reason: `'dbt-core ${spec}' sets no lower bound, so 1.8 satisfies it. Add '>= ${DBT_CORE_FLOOR}'. Why: ${why}.` });
        continue;
      }
      const lowest = lower.reduce((acc, x) => (cmp(x.v, acc.v) < 0 ? x : acc));
      const ok = cmp(lowest.v, DBT_CORE_FLOOR) > 0 || (cmp(lowest.v, DBT_CORE_FLOOR) === 0 && lowest.op !== '>');
      if (!ok) {
        violations.push({ path, spec: `dbt-core ${spec}`, reason: `'dbt-core ${spec}' allows ${lowest.v}, below the ${DBT_CORE_FLOOR} floor. Why: ${why}.` });
      }
    }
  }
  return violations;
}

/** Both floors over one scan. */
export function checkVersionFloors(entries) {
  return [...checkMetricflowFloor(entries), ...checkDbtCoreFloor(entries)];
}

/** Walk a tree collecting the files a Python dependency can enter through. */
export function collectEntries(roots, base = process.cwd()) {
  const out = [];
  const walk = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (SKIP_DIRS.has(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (SCANNED.test(name)) {
        try {
          out.push({ path: relative(base, p), text: readFileSync(p, 'utf8') });
        } catch {
          /* unreadable file: nothing to assert about */
        }
      }
    }
  };
  for (const r of roots) walk(join(base, r));
  return out;
}

/** The trees the gate scans. */
export const FLOOR_ROOTS = ['images', 'charts', 'scripts', 'deploy', 'os-ui'];

// `file://${argv[1]}` breaks on a path containing a space, so compare proper file URLs.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = checkVersionFloors(collectEntries(FLOOR_ROOTS));
  if (violations.length) {
    for (const v of violations) console.error(`DENY  ${v.path}: ${v.reason}`);
    console.error(`\nVERSION FLOORS: FAIL — metricflow must resolve to >= ${METRICFLOW_FLOOR} (BSL 1.1 at <= 0.208.1) and dbt-core to >= ${DBT_CORE_FLOOR}.`);
    process.exit(1);
  }
  console.log(`ok    metricflow floor >= ${METRICFLOW_FLOOR} holds (BSL 1.1 releases <= 0.208.1 cannot enter a build)`);
  console.log(`ok    dbt-core floor >= ${DBT_CORE_FLOOR} holds (the generated semantic layer does not parse on 1.8)`);
}
