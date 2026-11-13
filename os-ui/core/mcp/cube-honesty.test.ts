/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Tripwire — no agent-facing text claims Cube secures or serves the number (X-R7/X9)
 * USER STORY: As an agent (or an engineer reading what the agent reads) I want the MCP tool
 *             descriptions, prompts, guides and tab context cards to name the component that
 *             actually runs my query, so that when I debug a wrong number I look in the right
 *             place — and so the OS's own vocabulary rule ("the artefact is the tool's") holds.
 * ARCHITECTURE:
 *   - MEASURED TRUTH, not opinion: the metric read path is `exploreMetric`
 *     (`tabs/metrics/lib/build/explore-server.ts`) — ONE governed Trino SELECT over the gold mart
 *     run under the viewer's delegated token, with Trino/OPA applying row and column security.
 *     Cube is on no read path (os-ui 0.6.x migrated metrics, then dashboards, off it). A surface
 *     that says Cube secures or serves the number sends every reader to the wrong component.
 *   - SCOPE. This tripwire covers the agent-facing text X owns. `tabs/metrics/**` is EXCLUDED by
 *     ownership, not by preference: stream M owns those strings tonight (plan X-R7, "M owns the
 *     strings under tabs/metrics; X owns any elsewhere"), and the findings there are filed in the
 *     plan's deviations log for M. `tabs/software/**` is excluded for the same reason (stream S).
 *     Widen the roots when those streams land — the list is the contract, so a reviewer can see
 *     exactly what is and is not proven here.
 *   - It reads files from disk; it imports no module under test, no `.tsx` and no route.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const OS_UI = join(import.meta.dirname, '..', '..');

/**
 * The agent-facing text: every MCP tool description, the golden-path prompts, the guides the OS
 * serves, and each tab's context card. Non-exhaustive on purpose — these are the surfaces an
 * agent actually reads.
 */
const ROOTS = ['core/mcp', 'core/guides', 'core/app-sdk', 'core/kernel/artifacts.ts', 'tabs'];

/** Ownership carve-outs (see ARCHITECTURE) plus the historical record, which must not be edited. */
const EXCLUDED = [
  'tabs/metrics/', // stream M owns these strings tonight
  'tabs/software/', // stream S owns tabs/software
];

/** Only text an agent or a reader is served. Tests and implementation comments are not it. */
function isAgentFacing(rel: string): boolean {
  if (rel.includes('/node_modules/') || rel.includes('/.next/')) return false;
  if (rel.includes('.test.')) return false;
  if (EXCLUDED.some((p) => rel.startsWith(p))) return false;
  if (rel.endsWith('.md')) return /\/(context|guide|guides)[^/]*\.md$/.test(rel) || rel.startsWith('core/guides/');
  if (!rel.endsWith('.ts')) return false; // no .tsx: a component is not an agent-facing string
  return rel.startsWith('core/mcp/') || rel.startsWith('core/app-sdk/') || rel.endsWith('core/kernel/artifacts.ts') || /\/mcp\//.test(rel);
}

function walk(abs: string, out: string[] = []): string[] {
  const st = statSync(abs);
  if (st.isFile()) {
    out.push(abs);
    return out;
  }
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name === '.next') continue;
    walk(join(abs, name), out);
  }
  return out;
}

function agentFacingFiles(): string[] {
  const files: string[] = [];
  for (const root of ROOTS) {
    for (const abs of walk(join(OS_UI, root))) {
      const rel = relative(OS_UI, abs).split('\\').join('/');
      if (isAgentFacing(rel)) files.push(abs);
    }
  }
  return files;
}

/**
 * The claims. Each one says Cube does something to the NUMBER — secures it, serves it, applies
 * row security to it, or is the layer the metric lives in. None of them is true.
 */
const FORBIDDEN: { re: RegExp; why: string }[] = [
  { re: /Cube\s+(?:applies|secures|enforces|serves|resolves|runs)\b/i, why: 'Cube does not touch the number — `exploreMetric` runs governed Trino SQL as the viewer' },
  { re: /Cube\s+(?:RLS|row-level security|row security)/i, why: 'row security on a metric is Trino/OPA under the delegated identity, not Cube' },
  { re: /\bCube\s+load\s+query\b/i, why: 'no Cube query is built on any read path' },
  { re: /\bCube\s+semantic\s+layer\b/i, why: 'the semantic layer is dbt metrics compiled to Trino SQL' },
  { re: /\bCube\s+metric\b/i, why: 'a metric is a dbt metric (KPI), not a Cube metric' },
  { re: /\bon\s+Cube\b/i, why: 'nothing renders or serves "on Cube"' },
  { re: /\bCube\s+member\b/i, why: 'the member is a governed metric member resolved to Trino SQL; nothing about it is Cube\'s' },
  { re: /compiles to \([^)]*\bCube\b/i, why: 'the policy view names OPA, OpenSearch-DLS and OPA/DLS — nothing compiles to Cube' },
  // Review L-6: the LIE CAN BE A KEY, not only prose. `spec: { cube: 'daily_revenue' }` on a seed
  // metric says the artefact is a Cube object in the one field a client reads as structure, and no
  // amount of corrected prose around it helps.
  { re: /(?:^|[\s{,'"])cube\s*:/i, why: 'a `cube:` field says the artefact is a Cube object — name the real shape (`view:`, `member:`)' },
];

/**
 * NOT asserted here, deliberately. A broader stale-Cube VOCABULARY backlog exists in surfaces
 * other streams own tonight (`tabs/dashboards/{context,guide}.md`, `tabs/data/{context,guide}.md`,
 * `core/mcp/experimental/data-write-tools.ts`) — a catch-all `/\bCube\b/` over the same roots
 * reports ~17 lines there. Those are filed in the plan's deviations log for their owners rather
 * than edited across ownership lines; X9 is scoped to the CLAIMS above, which are the ones that
 * send a reader to the wrong component for the NUMBER.
 */

test('X9: no agent-facing text claims Cube secures or serves the number', () => {
  const files = agentFacingFiles();
  // A tripwire that scanned nothing would pass forever.
  assert.ok(files.length > 40, `the scan found only ${files.length} agent-facing files — the roots or the filter are wrong`);
  const hits: string[] = [];
  for (const abs of files) {
    const rel = relative(OS_UI, abs).split('\\').join('/');
    const text = readFileSync(abs, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const { re, why } of FORBIDDEN) {
        if (re.test(line)) hits.push(`${rel}:${i + 1} — ${why}\n    ${line.trim().slice(0, 180)}`);
      }
    });
  }
  assert.deepEqual(hits, [], `agent-facing text still points at Cube:\n${hits.join('\n')}`);
});

test('X9: the tripwire can actually see a violation (it is not a no-op)', () => {
  const sample = 'Cube applies per-viewer row-level security from YOUR delegated identity.';
  assert.ok(FORBIDDEN.some(({ re }) => re.test(sample)), 'the live-0.8.0 sentence must match a forbidden pattern');
  assert.ok(!FORBIDDEN.some(({ re }) => re.test('Trino/OPA apply row and column security as the viewer.')), 'the truthful replacement must not match');
});

test('X9: the carve-outs are explicit, so a reviewer sees what is NOT proven here', () => {
  // Filed as deviations for M and S rather than edited across ownership lines.
  assert.equal(isAgentFacing('tabs/metrics/context.md'), false, 'tabs/metrics is stream M tonight');
  assert.equal(isAgentFacing('tabs/software/ui/appspec/ChartExplorerRenderer.tsx'), false, 'tabs/software is stream S');
  assert.equal(isAgentFacing('core/mcp/prompts.ts'), true, 'the prompts ARE covered');
  assert.equal(isAgentFacing('tabs/admin/mcp/discovery-read-tools.ts'), true, 'per-tab MCP tool files are covered');
  assert.equal(isAgentFacing('tabs/data/context.md'), true, 'and every tab context card');
});
