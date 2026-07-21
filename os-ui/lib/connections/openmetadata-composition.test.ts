/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * #146 Phase 5 — OM ingestion COMPOSITION guard (the §5 namespace-separation rule).
 *
 * The analytics epic lights up THREE OpenMetadata ingestion legs. They must compose
 * WITHOUT double-writes, and the only thing that makes that true is that each leg owns
 * a DISTINCT service namespace:
 *
 *   leg 1 — dbt artifacts     → decorates the CUSTOMER's Trino service table entities
 *                               (chart: openmetadata.ingestion.dbt, FQN iceberg.<domain>.<table>)
 *   leg 3 — dagster pipelines  → the CUSTOMER's Dagster service pipeline entities
 *                               (chart: openmetadata.ingestion.dagster — optional, default off)
 *   leg 2 — #147 orchestrator  → the DEDICATED `sovereign_os` service, additively only
 *                               (os-ui openmetadata-ingest.ts → openmetadata-sync.ts)
 *
 * INVARIANT (docs/research/analytics-monorepo-plan.md §5): the chart-side dbt/dagster
 * ingestion MUST NEVER be pointed at the `sovereign_os` service, and the #147
 * orchestrator NEVER writes table entities under the customer's Trino service. Two
 * disjoint namespaces ⇒ leg 1/3 (customer entities) and leg 2 (sovereign_os entities)
 * never double-write the same entity.
 *
 * This test encodes that rule as a REAL, failing-if-violated check: it reads the SHIPPED
 * chart values + template and the SHIPPED orchestrator constant (`OS_SERVICE`), and a
 * negative case proves the guard bites (a config aimed at `sovereign_os` FAILS).
 *
 * Pure Node — no helm shell-out (CI-portable), no network, no server-only I/O beyond the
 * (already-tested) sync module import.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OS_SERVICE, OS_DOMAIN, osEntityFqns } from '@/lib/connections/openmetadata-sync.ts';

// --- Locate the shipped chart from THIS test file (not cwd) --------------------
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHART = path.resolve(HERE, '../../../charts/sovereign-agentic-os');
const VALUES = readFileSync(path.join(CHART, 'values.yaml'), 'utf8');
const TEMPLATE = readFileSync(
  path.join(CHART, 'templates/openmetadata/trino-ingestion.yaml'),
  'utf8',
);

// --- Minimal, block-scoped YAML scalar reader ----------------------------------
// We do not add a YAML dependency; the keys we assert on are plain scalars at a known
// indent under `openmetadata.ingestion`. `scalarUnder(block, key)` returns the first
// unquoted-or-quoted scalar value for `key` at any indent WITHIN the given text block.
function scalarUnder(block: string, key: string): string | undefined {
  const m = block.match(new RegExp(`(?:^|\\n)\\s*${key}:\\s*"?([^"\\n#]+?)"?\\s*(?:#.*)?(?:\\n|$)`));
  return m ? m[1].trim() : undefined;
}

// Slice the text of a top-level-ish key's sub-block by indentation, so `service:` inside
// `dagster:` is not confused with the ingestion-level `service:`.
function blockOf(src: string, key: string, keyIndent: number): string {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => l.match(new RegExp(`^\\s{${keyIndent}}${key}:\\s*$`)));
  assert.notEqual(start, -1, `values.yaml must contain the "${key}" block at indent ${keyIndent}`);
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') { out.push(l); continue; }
    const indent = l.length - l.trimStart().length;
    if (indent <= keyIndent) break; // dedented out of the block
    out.push(l);
  }
  return out.join('\n');
}

const ingestion = blockOf(VALUES, 'ingestion', 2); // openmetadata.ingestion
const dbt = blockOf(ingestion, 'dbt', 4);
const dagster = blockOf(ingestion, 'dagster', 4);

// ============================================================================
// leg 1 + leg 3 — the chart ingestion NEVER targets the sovereign_os namespace
// ============================================================================

test('§5: OS_SERVICE is the dedicated sovereign_os namespace (anchors the whole rule)', () => {
  // If this constant ever changes, the guard below must be revisited — assert it here
  // so the test tracks the SHIPPED orchestrator value, never a drifting literal.
  assert.equal(OS_SERVICE, 'sovereign_os');
});

test('§5: the dbt/lineage ingestion service (leg 1) is NOT sovereign_os', () => {
  const service = scalarUnder(ingestion, 'service');
  assert.ok(service, 'ingestion.service must be set');
  assert.notEqual(service, OS_SERVICE, 'dbt/lineage crawl must decorate the customer Trino service, never sovereign_os');
  assert.equal(service, 'trino', 'default target is the customer Trino service (FQN iceberg.<domain>.<table>)');
});

test('§5: the dbt artifacts source points at the dbt/artifacts S3 prefix, not the OS namespace', () => {
  const bucket = scalarUnder(dbt, 'bucket');
  const prefix = scalarUnder(dbt, 'prefix');
  assert.equal(bucket, 'dbt', 'dbt artifacts live in the dbt bucket');
  assert.equal(prefix, 'artifacts/', 'the CI publish-dbt-artifacts job uploads to artifacts/');
  // The dbt config never names a service at all (it decorates the Trino crawl output);
  // belt-and-braces: sovereign_os must not appear anywhere in the dbt config block.
  assert.ok(!dbt.includes(OS_SERVICE), 'the dbt ingestion config must never mention sovereign_os');
});

test('§5: the OPTIONAL Dagster pipeline ingestion (leg 3) targets its own service, NOT sovereign_os', () => {
  assert.equal(scalarUnder(dagster, 'enabled'), 'false', 'leg 3 ships default OFF (droppable, unverified pairing)');
  const service = scalarUnder(dagster, 'service');
  assert.ok(service, 'ingestion.dagster.service must be set');
  assert.notEqual(service, OS_SERVICE, 'Dagster pipeline entities must land under their own service, never sovereign_os');
  assert.equal(service, 'dagster');
});

test('§5: the trino-ingestion template only ever binds serviceName to $i.service / $i.dagster.service (never a hardcoded sovereign_os)', () => {
  // Every serviceName in the rendered workflows is templated from values (asserted above),
  // so the literal `sovereign_os` must appear NOWHERE as a config target in the template —
  // its only allowed appearances are Go-template comment blocks ({{- /* … */ -}}) and
  // shell `#` comments explaining the rule. Strip template comment blocks, then scan.
  const withoutTplComments = TEMPLATE.replace(/\{\{-?\s*\/\*[\s\S]*?\*\/\s*-?\}\}/g, '');
  const configLines = withoutTplComments.split('\n').filter((l) => {
    const t = l.trim();
    return t.includes('sovereign_os') && !t.startsWith('#') && !t.startsWith('{{-');
  });
  assert.deepEqual(configLines, [], `sovereign_os must not appear as a config value in the template; found: ${JSON.stringify(configLines)}`);
  // And the serviceName bindings are exactly the values-driven ones.
  assert.ok(TEMPLATE.includes('serviceName: {{ $i.service | quote }}'), 'dbt/lineage serviceName is values-driven');
  assert.ok(TEMPLATE.includes('serviceName: {{ $i.dagster.service | quote }}'), 'dagster serviceName is values-driven');
});

// ============================================================================
// leg 2 — the #147 orchestrator writes ONLY under sovereign_os, never the Trino service
// ============================================================================

test('§5: the #147 orchestrator entity FQNs live under sovereign_os and NEVER under the Trino service', () => {
  const trinoService = scalarUnder(ingestion, 'service')!; // "trino"
  const fqns = osEntityFqns({ id: 'ds1', name: 'Orders Mart', domain: 'sales', tier: 'product' });
  assert.ok(fqns.table.startsWith(`${OS_SERVICE}.`), 'the orchestrator table entity is under sovereign_os');
  assert.ok(!fqns.table.startsWith(`${trinoService}.`), 'the orchestrator NEVER writes a table entity under the Trino service (no double-write with leg 1)');
  // Data-Product entities live under the OS Domain, again disjoint from the Trino service.
  assert.ok(fqns.dataProduct!.startsWith(`${OS_DOMAIN}.`));
  assert.ok(!fqns.dataProduct!.startsWith(`${trinoService}.`));
});

// ============================================================================
// NEGATIVE — the guard BITES: a config aimed at sovereign_os FAILS the rule
// ============================================================================

// The exact predicate the review rule encodes, factored out so both a real config and a
// violating one run through the SAME check.
function violatesNamespaceRule(ingestionServiceName: string): boolean {
  return ingestionServiceName === OS_SERVICE;
}

test('§5 GUARD BITES: a dbt/dagster ingestion pointed at sovereign_os is REJECTED', () => {
  // Sanity: the shipped config passes.
  assert.equal(violatesNamespaceRule(scalarUnder(ingestion, 'service')!), false, 'shipped config is compliant');
  assert.equal(violatesNamespaceRule(scalarUnder(dagster, 'service')!), false, 'shipped dagster config is compliant');
  // The violation the rule exists to catch: an operator (mis)aiming the crawl at the OS namespace.
  assert.equal(violatesNamespaceRule('sovereign_os'), true, 'a config targeting sovereign_os MUST fail the guard');
  // And a template that hardcoded the OS service as a serviceName target would be caught
  // by the template scan above; assert that scan is real by simulating a violating line.
  const violatingTemplate = 'serviceName: "sovereign_os"';
  const bad = violatingTemplate.split('\n').filter((l) => l.trim().includes('sovereign_os') && !l.trim().startsWith('#'));
  assert.deepEqual(bad, [violatingTemplate], 'the template scan detects a sovereign_os serviceName target');
});
