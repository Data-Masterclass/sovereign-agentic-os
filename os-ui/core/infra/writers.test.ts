/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Ratchet — ONE Langfuse writer in os-ui (design 05 §7, WP-31)
 * USER STORY: As the owner I want a second, hand-written Langfuse sender to fail CI the day it is
 *             added, so a model call can never again be recorded twice and redaction can never be
 *             bypassed by a side door.
 * ARCHITECTURE: a source scan of os-ui (no node_modules, no build output). Only
 *             `core/infra/langfuse.ts` may import a Langfuse SDK package or name a Langfuse write
 *             endpoint. The real-server proofs are exempt, by name: the engine's
 *             `tracing.e2e.test.ts`, whose negative twin re-introduces a second writer ON PURPOSE,
 *             and the gateway's `core/runtime/tracing.e2e.test.ts` (WP-32), which plays the app's
 *             OTLP exporter for one span so the LiteLLM hop is tested on its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const WRITER = 'core/infra/langfuse.ts';
// `core/adapters/langfuse/metrics.int.test.ts` seeds FIXTURE traces into the test Langfuse through its public
// ingestion API so the Metrics API READ can be checked against known latencies; os-ui never writes that way.
const EXEMPT = new Set([WRITER, 'tabs/agents/lib/engine/tracing.e2e.test.ts', 'core/runtime/tracing.e2e.test.ts', 'core/infra/writers.test.ts', 'core/adapters/langfuse/metrics.int.test.ts']);
const SKIP_DIRS = new Set(['node_modules', '.next', 'out', 'coverage', '.turbo']);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx|mjs|js|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const SDK_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)['"](?:langfuse|langfuse-core|langfuse-node|@langfuse\/[\w-]+)['"]/;
const WRITE_ENDPOINT = /\/api\/public\/(?:ingestion|otel)\b/;

test('RATCHET: only core/infra/langfuse.ts imports a Langfuse SDK package or calls a Langfuse write endpoint', () => {
  const offenders: string[] = [];
  for (const file of sources(ROOT)) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (EXEMPT.has(rel)) continue;
    const text = readFileSync(file, 'utf8');
    if (SDK_IMPORT.test(text)) offenders.push(`${rel}: imports a Langfuse SDK package`);
    if (WRITE_ENDPOINT.test(text)) offenders.push(`${rel}: names a Langfuse write endpoint`);
  }
  assert.deepEqual(offenders, [], `a second Langfuse writer:\n${offenders.join('\n')}`);
});

test('RATCHET: the writer itself never posts raw batches — it uses the OTel span processor', () => {
  const text = readFileSync(join(ROOT, WRITER), 'utf8');
  assert.doesNotMatch(text, WRITE_ENDPOINT, 'the writer must export through LangfuseSpanProcessor, not a hand-built POST');
  assert.match(text, /new LangfuseSpanProcessor\(/);
  assert.match(text, /shouldExportSpan: exportOsSpan/, 'app-side generations are filtered at export');
});

test('RATCHET (negative twin): the scan catches a re-introduced hand-written sender', () => {
  const planted = "await fetch(`${config.langfuseUrl}/api/public/ingestion`, { method: 'POST' })";
  assert.ok(WRITE_ENDPOINT.test(planted));
  assert.ok(SDK_IMPORT.test("import { Langfuse } from 'langfuse';"));
  assert.ok(SDK_IMPORT.test("import { startObservation } from '@langfuse/tracing';"));
});
