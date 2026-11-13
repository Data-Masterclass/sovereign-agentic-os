/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The ratchet that keeps ONE ECharts registration surface in the OS (D1)
 * USER STORY: As a maintainer I want a second `echarts.use([...])` to fail the suite the moment it
 *             lands, because three independent registrations is how a chart becomes inconsistent
 *             in two tabs at once — which is exactly the state this stream found the tree in.
 * ARCHITECTURE:
 *   - A filesystem grep, not an import: it must see files it would be wrong to load (`.tsx`,
 *     client modules, the vendored tree), and a test may not import a `.tsx`.
 *   - `core/ui/charts/register.ts` is the sole permitted call site. Nothing else — not a tab, not
 *     another core module, not `os-ui/vendor/**` — may name the `echarts` package.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `os-ui/` — this file is at `os-ui/core/ui/charts/`. */
const UI = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The ONE file allowed to import the `echarts` package. */
const SURFACE = 'core/ui/charts/register.ts';

const SKIP_DIRS = new Set(['node_modules', '.next', 'public', 'dist']);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(p)) out.push(p);
  }
  return out;
}

/** `from 'echarts…'` / `import 'echarts…'` / `require('echarts…')` — any way in. */
const ECHARTS_IMPORT = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*)['"]echarts(?:\/[^'"]*)?['"]/;

test('only core/ui/charts/register.ts imports the echarts package', () => {
  const offenders: string[] = [];
  for (const file of walk(UI)) {
    const rel = relative(UI, file).split('\\').join('/');
    if (rel === SURFACE) continue;
    // This ratchet names the pattern it looks for, so it would always match itself.
    if (rel === 'core/ui/charts/echarts-surface.test.ts') continue;
    if (ECHARTS_IMPORT.test(readFileSync(file, 'utf8'))) offenders.push(rel);
  }
  assert.deepEqual(
    offenders,
    [],
    `these files import 'echarts' directly — route them through @core/ui/charts instead:\n  ${offenders.join('\n  ')}`,
  );
});

test('the surface really does register the chart types the OS draws', () => {
  const src = readFileSync(join(UI, SURFACE), 'utf8');
  assert.match(src, /echarts\.use\(\[/, 'register.ts must hold the single echarts.use([...]) call');
  for (const needed of ['LineChart', 'BarChart', 'PieChart', 'GridComponent', 'TooltipComponent', 'LegendComponent', 'CanvasRenderer']) {
    assert.ok(src.includes(needed), `register.ts must register ${needed}`);
  }
});

test('the vendored Superset tree imports no package at all', () => {
  const vendor = join(UI, 'vendor');
  for (const file of walk(vendor)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:from|import|require\()\s*['"]([^'"]+)['"]/g)) {
      const spec = m[1];
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../'),
        `${relative(UI, file)} imports '${spec}' — os-ui/vendor/** must stay dependency-free (relative imports only)`,
      );
    }
  }
});
