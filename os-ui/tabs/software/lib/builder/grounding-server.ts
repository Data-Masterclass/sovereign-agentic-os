/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        software
 * FEATURE:    Gathering the GROUNDING PACK through the governed doors, as the signed-in user
 * USER STORY: As the signed-in user whose app is being built I want the builder to see exactly the
 *             data I can see — the real columns and a few real rows — and nothing more, so the app
 *             it writes is grounded in my reality and the build never widens my access.
 * ARCHITECTURE:
 *   - IDENTITY: every read goes through the ONE governed in-process MCP door
 *     (`core/mcp/server.ts` `handleRpc(user, …)`) as the SIGNED-IN USER. No service principal, no
 *     store reached around the gate, no cross-tab import of another tab's internals.
 *   - BOUNDED: `GROUNDING_SAMPLE_ROWS` rows and `GROUNDING_SAMPLE_COLUMNS` columns per dataset,
 *     one `SELECT * … LIMIT n` per granted dataset, nothing else.
 *   - HONEST: a dataset whose schema or sample could not be read gets a NOTE and a line in
 *     `pack.gaps`. There is no fabricated row anywhere in this file.
 *   - EXTRACTED, NOT WRITTEN: the SDK and UI surfaces and the design tokens come from the shipped
 *     `core/app-sdk`, `core/app-ui` source via the existing vendor readers, so they cannot drift.
 *   - `handleRpc` is imported LAZILY (type-only at the top, `await import` at the call site). A
 *     STATIC import deadlocks the process: `core/mcp/server` top-level-awaits its experimental
 *     bundle registration, one of those bundles is `platform-tools`, which imports
 *     `tabs/software/lib/platform-mcp` — the file carrying the Build dispatch that reaches this
 *     module. A static edge back to `@core/mcp/server` closes that cycle on a pending top-level
 *     await, and every test that touches the MCP server hangs. Keep it lazy.
 */
import 'server-only';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CurrentUser } from '@core/kernel/auth';
import type { JsonRpcRequest } from '@core/mcp/server';
import { readSdkSource } from '@tabs/software/lib/app-sdk-vendor';
import { readUiSource } from '@tabs/software/lib/app-ui-vendor';
import { viteOsFiles } from '@tabs/software/lib/scaffolds/vite-os';
import type { App, AppStory } from '@tabs/software/lib/apps';
import type { BuildTarget } from '@tabs/software/lib/build-target';
import {
  GROUNDING_SAMPLE_COLUMNS,
  GROUNDING_SAMPLE_ROWS,
  TIER2_CONSTRAINTS,
  clipDefinition,
  extractDesignTokens,
  extractSdkSurface,
  extractUiSurface,
  pickExemplar,
  type GroundingDataset,
  type GroundingMetric,
  type GroundingPack,
  type GroundingStory,
} from '@tabs/software/lib/builder/grounding';

/** One governed tool call as the signed-in user. Returns the parsed payload, or an honest error. */
async function callGoverned(
  user: CurrentUser,
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; payload: unknown } | { ok: false; reason: string }> {
  const req: JsonRpcRequest = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } };
  let res: Awaited<ReturnType<(typeof import('@core/mcp/server'))['handleRpc']>>;
  try {
    // LAZY — see the cycle note in the header. This is the SAME governed door the UI and the MCP
    // use; only the module edge is deferred, never the gate.
    const { handleRpc } = await import('@core/mcp/server');
    res = await handleRpc(user, req);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
  if (!res) return { ok: false, reason: `${name} returned no response` };
  if (res.error) return { ok: false, reason: res.error.message };
  const result = res.result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
  const text = result?.content?.find((c) => c.type === 'text')?.text ?? '';
  if (result?.isError) return { ok: false, reason: text || `${name} refused the call` };
  try {
    return { ok: true, payload: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: `${name} did not return a JSON payload` };
  }
}

function asRecord(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' ? (x as Record<string, unknown>) : {};
}

/** Column names out of whatever shape a governed read returned them in. */
function columnNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const c of raw) {
    if (typeof c === 'string') out.push(c);
    else {
      const name = asRecord(c).name ?? asRecord(c).column ?? asRecord(c).field;
      if (typeof name === 'string') out.push(name);
    }
  }
  return out;
}

/** Sample rows as strings, from either array-rows or object-rows, bounded to the column list. */
function sampleRows(raw: unknown, columns: string[]): string[][] {
  if (!Array.isArray(raw)) return [];
  const rows: string[][] = [];
  for (const r of raw.slice(0, GROUNDING_SAMPLE_ROWS)) {
    if (Array.isArray(r)) {
      rows.push(r.slice(0, columns.length).map(cell));
    } else {
      const rec = asRecord(r);
      rows.push(columns.map((c) => cell(rec[c])));
    }
  }
  return rows;
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 80)}...` : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v).slice(0, 80);
}

/** The stories this build is for, flattened for the grounding pack. */
export function storiesForTarget(app: App, target: BuildTarget): GroundingStory[] {
  const out: GroundingStory[] = [];
  const flatten = (epicId: string, s: AppStory): GroundingStory => {
    const rules = [...(s.spec?.rules ?? [])];
    if (s.acceptance && s.acceptance.trim().length > 0) rules.push(`acceptance: ${s.acceptance.trim()}`);
    const narrative =
      s.asA || s.iWant || s.soThat ? `As a ${s.asA || '(user)'} I want ${s.iWant || '(…)'} so that ${s.soThat || '(…)'}` : undefined;
    return {
      epicId,
      storyId: s.id,
      title: s.title,
      ...(narrative ? { narrative } : {}),
      features: [...(s.spec?.features ?? [])],
      nfrs: [...(s.spec?.nfrs ?? [])],
      rules,
    };
  };
  for (const e of app.epics ?? []) {
    if (target.kind === 'epic' && e.id !== target.epicId) continue;
    if (target.kind === 'story' && e.id !== target.epicId) continue;
    for (const s of e.stories ?? []) {
      if (target.kind === 'story' && s.id !== target.storyId) continue;
      out.push(flatten(e.id, s));
    }
  }
  return out;
}

/** A human label for the build target (used in the pack header and the commit message). */
export function targetLabelFor(target: BuildTarget): string {
  if (target.kind === 'app') return 'all';
  if (target.kind === 'epic') return target.epicId;
  return `${target.epicId}/${target.storyId}`;
}

/** The granted datasets with their REAL columns and up to N REAL sample rows. */
async function gatherDatasets(user: CurrentUser, app: App, gaps: string[]): Promise<GroundingDataset[]> {
  const out: GroundingDataset[] = [];
  for (const grant of app.grants?.data ?? []) {
    const got = await callGoverned(user, 'get_dataset', { datasetId: grant.id });
    if (!got.ok) {
      gaps.push(`dataset ${grant.id}: not readable as you right now (${got.reason}) — do not reference its columns`);
      out.push({ id: grant.id, name: grant.id, columns: [], sampleColumns: [], sampleRows: [], note: `not readable: ${got.reason}` });
      continue;
    }
    const d = asRecord(got.payload);
    const name = typeof d.name === 'string' ? d.name : grant.id;
    const fqn = (() => {
      const q = asRecord(d.queryable);
      return typeof q.fqn === 'string' ? q.fqn : typeof q.table === 'string' ? q.table : null;
    })();
    const catalogueColumns = columnNames(d.columns ?? asRecord(d.schema).columns);
    if (!fqn) {
      const note = 'no queryable physical table yet (nothing built) — no sample rows available';
      gaps.push(`dataset ${grant.id}: ${note}`);
      out.push({ id: grant.id, name, columns: catalogueColumns, sampleColumns: [], sampleRows: [], note });
      continue;
    }
    const q = await callGoverned(user, 'query_data', { sql: `SELECT * FROM ${fqn} LIMIT ${GROUNDING_SAMPLE_ROWS}` });
    if (!q.ok) {
      const note = `schema from the catalogue; no sample rows (${q.reason})`;
      gaps.push(`dataset ${grant.id}: ${note}`);
      out.push({ id: grant.id, name, columns: catalogueColumns, sampleColumns: [], sampleRows: [], note });
      continue;
    }
    const r = asRecord(q.payload);
    const queried = columnNames(r.columns);
    const columns = queried.length > 0 ? queried : catalogueColumns;
    const sampleColumns = columns.slice(0, GROUNDING_SAMPLE_COLUMNS);
    const rows = sampleRows(r.rows, sampleColumns);
    const clipped = columns.length > sampleColumns.length;
    const note = clipped
      ? `sample clipped to the first ${sampleColumns.length} of ${columns.length} columns (the column list above is complete)`
      : rows.length === 0
        ? 'the governed read returned no rows — the table is empty for you'
        : undefined;
    if (note && rows.length === 0) gaps.push(`dataset ${grant.id}: ${note}`);
    out.push({ id: grant.id, name, columns, sampleColumns, sampleRows: rows, ...(note ? { note } : {}) });
  }
  return out;
}

/** The granted metrics with their definitions as the OS holds them. */
async function gatherMetrics(user: CurrentUser, app: App, gaps: string[]): Promise<GroundingMetric[]> {
  const out: GroundingMetric[] = [];
  for (const grant of app.grants?.metrics ?? []) {
    const got = await callGoverned(user, 'get_metric', { metricId: grant.id });
    if (!got.ok) {
      gaps.push(`metric ${grant.id}: not readable as you right now (${got.reason})`);
      out.push({ id: grant.id, name: grant.id, definition: null, note: `not readable: ${got.reason}` });
      continue;
    }
    const m = asRecord(got.payload);
    const name = typeof m.name === 'string' ? m.name : grant.id;
    // The definition as the OS holds it: the semantic YAML when present, else the expression /
    // measures the metric record carries. Never re-worded — it is the artefact, not a paraphrase.
    const raw =
      (typeof m.yaml === 'string' && m.yaml) ||
      (typeof m.definition === 'string' && m.definition) ||
      (typeof m.expression === 'string' && m.expression) ||
      (typeof m.sql === 'string' && m.sql) ||
      '';
    if (raw.length === 0) {
      out.push({ id: grant.id, name, definition: null, note: 'the metric record carries no definition text' });
      continue;
    }
    const { text, clipped } = clipDefinition(raw);
    out.push({ id: grant.id, name, definition: text, ...(clipped ? { note: 'definition clipped' } : {}) });
  }
  return out;
}

/** The design tokens from the portable theme the app imports. */
function gatherTokens(gaps: string[]): ReturnType<typeof extractDesignTokens> {
  try {
    const css = readFileSync(join(process.cwd(), 'core', 'app-ui', 'theme.css'), 'utf8');
    return extractDesignTokens(css);
  } catch (e) {
    const note = `could not read core/app-ui/theme.css (${e instanceof Error ? e.message : String(e)})`;
    gaps.push(note);
    return { names: [], note };
  }
}

/**
 * Assemble the whole grounding pack for one build. Every gathered piece is governed material the
 * caller may already see; everything missing is recorded in `gaps` and rendered.
 */
export async function assembleGroundingPack(user: CurrentUser, app: App, target: BuildTarget): Promise<GroundingPack> {
  const gaps: string[] = [];
  const stories = storiesForTarget(app, target);
  if (stories.length === 0) gaps.push('no user story matched this build target — there is nothing to build from');

  const datasets = await gatherDatasets(user, app, gaps);
  const metrics = await gatherMetrics(user, app, gaps);

  const sdk = (() => {
    try {
      return extractSdkSurface(readSdkSource('node_modules/@sovereign-os/app-sdk'));
    } catch (e) {
      const note = `could not read the app-sdk source (${e instanceof Error ? e.message : String(e)})`;
      gaps.push(note);
      return { package: '@sovereign-os/app-sdk', signatures: [], note };
    }
  })();
  if (sdk.note) gaps.push(sdk.note);

  const ui = (() => {
    try {
      return extractUiSurface(readUiSource('node_modules/@sovereign-os/ui'));
    } catch (e) {
      const note = `could not read the app-ui source (${e instanceof Error ? e.message : String(e)})`;
      gaps.push(note);
      return { package: '@sovereign-os/ui', components: [], props: [], note };
    }
  })();
  if (ui.note) gaps.push(ui.note);

  const tokens = gatherTokens(gaps);

  const exemplar = (() => {
    try {
      // The shipped Vite scaffold IS the exemplar of a correct Tier-2 app — entry, shell, page and
      // the OS client, in the order the scaffold declares them.
      return pickExemplar('vite-os scaffold (the shape every OS app starts from)', viteOsFiles('Example App', 'example-app'));
    } catch (e) {
      const note = `could not read the vite-os scaffold (${e instanceof Error ? e.message : String(e)})`;
      gaps.push(note);
      return { name: 'vite-os scaffold', files: [], note };
    }
  })();

  return {
    app: { id: app.id, name: app.name, slug: app.slug, description: app.description, template: app.template },
    target: targetLabelFor(target),
    stories,
    datasets,
    metrics,
    sdk,
    ui,
    tokens,
    exemplar,
    constraints: [...TIER2_CONSTRAINTS],
    gaps,
  };
}
