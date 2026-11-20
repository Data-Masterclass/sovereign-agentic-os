/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    A dataset's versions, read from and written to Iceberg itself (WP-37).
 * USER STORY: As a data owner I want my dataset's history, a diff of two versions, a restore and a
 *             named pin, each for MY dataset only, so that undoing a bad build can never change
 *             another dataset that happens to read a table of the same name.
 * ARCHITECTURE:
 *   - The OS keeps NO version records for data. A version is an Iceberg snapshot, a named version
 *     is an Iceberg tag or branch, read on demand AS THE VIEWER (10 F13). SQL: `iceberg-sql.ts`.
 *   - Per dataset, never per table: `resolveVersionTable` maps the dataset to the ONE table it is
 *     served from for this viewer (`builtLayerFqn`, the resolver every read uses), then refuses
 *     a table that any OTHER dataset (archived ones included) can also map to. Two datasets on
 *     one table would otherwise share one history: a restore for one would rewrite the other.
 *     A legacy, name-only lane table is refused for writes (its history may hold another
 *     dataset's builds, as on 18 Nov), and its listing says so.
 *   - Side effects come in through `VersionDeps`, so the same code runs on the governed path in
 *     production (`dataset-versions-server.ts`) and on the real Trino + Polaris harness in CI.
 */
import type { Dataset, Layer } from '@tabs/data/lib/dataset-schema';
import {
  builtLayerFqn, domainSchema, laneFqn, laneIsUnique, physicalSlug,
} from '@tabs/data/lib/store-fqn';
import {
  diffCountsSql, diffRowsSql, refName, refRows, refsSql, rollbackSql, snapshotId, snapshotRows, snapshotsSql,
  type RefRow, type SnapshotRow, type VersionSel,
} from '@tabs/data/lib/iceberg-sql';

const LAYERS: Layer[] = ['bronze', 'silver', 'gold'];

export type VersionViewer = { id: string; domains: string[]; role?: string };

/** A refusal with a stable code, a status and the facts a UI or agent can act on. */
export class VersionTableError extends Error {
  readonly status: number;
  readonly code: 'not_built' | 'shared_table' | 'legacy_lane' | 'not_iceberg' | 'forbidden';
  readonly detail: Record<string, unknown>;
  constructor(code: VersionTableError['code'], message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'VersionTableError';
    this.code = code;
    this.detail = detail;
    this.status = code === 'forbidden' ? 403 : 409;
  }
}

/**
 * EVERY Iceberg table a dataset can map to, for any viewer and any layer: its owner's lane
 * tables, its domain copies and a connected dataset's synced copy. Deliberately wider than what
 * one viewer reads, so the shared-table check errs on the side of refusing.
 */
export function datasetTables(d: Dataset): Set<string> {
  const out = new Set<string>();
  if (d.connected?.mode === 'live') {
    const s = d.connected.source;
    out.add(`${s.catalog}.${s.schema}.${s.table}`.toLowerCase());
    return out;
  }
  const dom = `iceberg.${domainSchema(d.domain)}`;
  for (const l of LAYERS) {
    out.add(laneFqn(d, l));
    out.add(`${dom}.${l}_${physicalSlug(d)}`);
  }
  if (d.connected?.mode === 'sync') out.add(`${dom}.${d.connected.tier}_${physicalSlug(d)}`);
  return out;
}

export type Sibling = { id: string; name: string; archived: boolean };

/** The OTHER datasets (archived included) that can map to `fqn`. */
export function siblingsOn(fqn: string, self: Dataset, all: readonly (Dataset & { archived?: boolean })[]): Sibling[] {
  const key = fqn.toLowerCase();
  return all
    .filter((o) => o.id !== self.id && datasetTables(o).has(key))
    .map((o) => ({ id: o.id, name: o.name, archived: !!o.archived }));
}

export type VersionTable = {
  fqn: string;
  layer: Layer;
  /** The Trino identity the read or write runs as (the one that owns the schema). */
  principal: string;
  /** A name-only lane table from before lane names were unique: listed, never written. */
  legacyLane: boolean;
};

/**
 * The ONE table this dataset's versions live in for this viewer, or a typed refusal.
 * `intent: 'write'` (restore, name a version) additionally refuses a legacy lane.
 */
export function resolveVersionTable(
  d: Dataset,
  viewer: VersionViewer,
  all: readonly (Dataset & { archived?: boolean })[],
  opts: { layer?: Layer; intent?: 'read' | 'write' } = {},
): VersionTable {
  if (d.connected?.mode === 'live') {
    throw new VersionTableError('not_iceberg', `“${d.name}” is read live from ${d.connected.source.catalog}; its versions are kept by that system, not by this lakehouse.`, { datasetId: d.id });
  }
  const hit = builtLayerFqn(d, viewer, opts.layer);
  if (!hit) {
    throw new VersionTableError('not_built', `“${d.name}” has no built ${opts.layer ?? ''} table to read versions from yet.`.replace('  ', ' '), { datasetId: d.id, layer: opts.layer ?? null });
  }
  const siblings = siblingsOn(hit.fqn, d, all);
  if (siblings.length) {
    throw new VersionTableError(
      'shared_table',
      `${hit.fqn} is also mapped by ${siblings.map((s) => `“${s.name}” (${s.id}${s.archived ? ', archived' : ''})`).join(', ')}. ` +
        'Its snapshot history is not this dataset’s alone, so its versions are not shown or changed here. Rebuild the dataset under its own lane name first.',
      { datasetId: d.id, table: hit.fqn, siblings },
    );
  }
  const legacyLane = hit.fqn === laneFqn(d, hit.layer) && !laneIsUnique(d);
  if (legacyLane && opts.intent === 'write') {
    throw new VersionTableError(
      'legacy_lane',
      `${hit.fqn} is a name-only lane table from before lane names were unique; its history may contain another dataset’s builds, so it is not restored or tagged. Rebuild the dataset to give it its own table.`,
      { datasetId: d.id, table: hit.fqn },
    );
  }
  return { fqn: hit.fqn, layer: hit.layer, principal: hit.principal, legacyLane };
}

// ------------------------------------------------------------------------------- the calls ---

export type WriteIdentity = { principal: string; uid: string; domains: string[]; role: string };

export type VersionDeps = {
  /** A governed read as `principal`; rows as returned by Trino. */
  query(sql: string, principal: string, fqn: string): Promise<{ rows: unknown[][]; columns?: string[] }>;
  /** A governed write (the approved-write path). */
  execute(sql: string, identity: WriteIdentity, fqn: string): Promise<void>;
  /** Commit an Iceberg tag or branch through the catalog (data-runner → PyIceberg → Polaris). */
  createRef(body: {
    principal: string; uid: string; role: string; domains: string[];
    schema: string; table: string; kind: 'tag' | 'branch'; name: string; snapshotId: string;
  }): Promise<void>;
};

export type DatasetVersion = SnapshotRow & { current: boolean; refs: { name: string; type: 'TAG' | 'BRANCH' }[] };

export type DatasetVersions = {
  datasetId: string;
  table: string;
  layer: Layer;
  /** The snapshot the table reads today (the `main` branch). */
  current: string | null;
  versions: DatasetVersion[];
  refs: RefRow[];
  legacyLane: boolean;
};

/** Every version of the dataset's table, newest first, with the tags and branches on each. */
export async function listVersions(
  d: Dataset, viewer: VersionViewer, all: readonly Dataset[], deps: VersionDeps, layer?: Layer,
): Promise<DatasetVersions> {
  const t = resolveVersionTable(d, viewer, all, { layer, intent: 'read' });
  const [snaps, refs] = await Promise.all([
    deps.query(snapshotsSql(t.fqn), t.principal, t.fqn).then((r) => snapshotRows(r.rows)),
    deps.query(refsSql(t.fqn), t.principal, t.fqn).then((r) => refRows(r.rows)),
  ]);
  const current = refs.find((r) => r.name === 'main' && r.type === 'BRANCH')?.snapshotId ?? null;
  const versions = snaps.map((s) => ({
    ...s,
    current: s.snapshotId === current,
    refs: refs.filter((r) => r.snapshotId === s.snapshotId && r.name !== 'main').map((r) => ({ name: r.name, type: r.type })),
  }));
  return { datasetId: d.id, table: t.fqn, layer: t.layer, current, versions, refs, legacyLane: t.legacyLane };
}

/** A version given as a snapshot id or a tag/branch name. */
export function parseSel(v: unknown): VersionSel {
  const s = String(v ?? '').trim();
  return /^[0-9]+$/.test(s) ? { snapshotId: snapshotId(s) } : { ref: refName(s) };
}

export type DatasetDiff = {
  datasetId: string;
  table: string;
  from: string;
  to: string;
  added: number;
  removed: number;
  columns: string[];
  rows: unknown[][];
};

/** What changed in the data between two versions: counts plus up to `limit` rows per side. */
export async function diffVersions(
  d: Dataset, viewer: VersionViewer, all: readonly Dataset[], deps: VersionDeps,
  input: { from: unknown; to: unknown; layer?: Layer; limit?: number },
): Promise<DatasetDiff> {
  const t = resolveVersionTable(d, viewer, all, { layer: input.layer, intent: 'read' });
  const a = parseSel(input.from);
  const b = parseSel(input.to);
  const counts = await deps.query(diffCountsSql(t.fqn, a, b), t.principal, t.fqn);
  const rows = await deps.query(diffRowsSql(t.fqn, a, b, input.limit ?? 50), t.principal, t.fqn);
  const [added, removed] = (counts.rows[0] ?? [0, 0]).map((n) => Number(n));
  return {
    datasetId: d.id, table: t.fqn, from: String(input.from), to: String(input.to),
    added, removed, columns: rows.columns ?? [], rows: rows.rows,
  };
}

/** Make an earlier snapshot the dataset's current data again (`rollback_to_snapshot`). */
export async function rollbackVersion(
  d: Dataset, editor: VersionViewer & { role: string }, all: readonly Dataset[], deps: VersionDeps,
  input: { snapshotId: unknown; layer?: Layer },
): Promise<{ datasetId: string; table: string; current: string }> {
  const t = resolveVersionTable(d, editor, all, { layer: input.layer, intent: 'write' });
  const id = snapshotId(input.snapshotId);
  const known = snapshotRows((await deps.query(snapshotsSql(t.fqn), t.principal, t.fqn)).rows);
  if (!known.some((s) => s.snapshotId === id)) {
    throw new VersionTableError('not_built', `snapshot ${id} is not a version of ${t.fqn} (it may have expired)`, { table: t.fqn, snapshotId: id });
  }
  await deps.execute(rollbackSql(t.fqn, id), identityFor(editor, t), t.fqn);
  const main = refRows((await deps.query(refsSql(t.fqn), t.principal, t.fqn)).rows).find((r) => r.name === 'main');
  if (main?.snapshotId !== id) throw new Error(`rollback of ${t.fqn} to ${id} did not take effect (main is ${main?.snapshotId ?? 'unknown'})`);
  return { datasetId: d.id, table: t.fqn, current: id };
}

/** Pin a snapshot by name: an Iceberg tag (kept forever by expiry) or a branch. */
export async function nameVersion(
  d: Dataset, editor: VersionViewer & { role: string }, all: readonly Dataset[], deps: VersionDeps,
  input: { snapshotId: unknown; name: unknown; kind?: 'tag' | 'branch'; layer?: Layer },
): Promise<{ datasetId: string; table: string; name: string; kind: 'tag' | 'branch'; snapshotId: string }> {
  const t = resolveVersionTable(d, editor, all, { layer: input.layer, intent: 'write' });
  const id = snapshotId(input.snapshotId);
  const name = refName(input.name);
  const kind = input.kind === 'branch' ? 'branch' : 'tag';
  const [, schema, table] = t.fqn.split('.');
  const who = identityFor(editor, t);
  await deps.createRef({ principal: who.principal, uid: who.uid, role: who.role, domains: who.domains, schema, table, kind, name, snapshotId: id });
  // Read back through Trino: the proof is the table's own `$refs`, not the runner's answer.
  const ref = refRows((await deps.query(refsSql(t.fqn), t.principal, t.fqn)).rows).find((r) => r.name === name);
  if (!ref || ref.snapshotId !== id) throw new Error(`${kind} '${name}' is not visible in ${t.fqn}$refs`);
  return { datasetId: d.id, table: t.fqn, name, kind, snapshotId: id };
}

function identityFor(editor: VersionViewer & { role: string }, t: VersionTable): WriteIdentity {
  return { principal: t.principal, uid: editor.id, domains: editor.domains, role: editor.role };
}
