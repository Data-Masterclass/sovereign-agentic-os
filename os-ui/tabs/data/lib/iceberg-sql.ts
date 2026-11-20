/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Dataset versions as Iceberg's own records (WP-37; design 06 §5.6, 10 F13, 11 A14).
 * USER STORY: As a data owner I want to see every version of my data, compare two of them, go back
 *             to one, and pin one by name, and I want plain Trino or Spark to see exactly the same.
 * ARCHITECTURE:
 *   - Pure SQL text for the Trino 476 Iceberg connector. No OS state: a version IS an Iceberg
 *     snapshot (`"<t>$snapshots"`), a named version IS an Iceberg tag or branch (`"<t>$refs"`),
 *     a read IS `FOR VERSION AS OF`, a restore IS `ALTER TABLE … EXECUTE rollback_to_snapshot`.
 *     https://trino.io/docs/476/connector/iceberg.html (metadata tables, time travel, procedures).
 *   - Every identifier and literal is validated here, before any text is built, so a value from a
 *     request can never widen a statement.
 *   - Import-free on purpose: tests/lakehouse/versions.int.test.mjs runs these exact strings on the
 *     real Trino + Polaris pair (Node strips the types), so what CI proves is what os-ui sends.
 */

export type TableRef = { catalog: string; schema: string; table: string };

/** Thrown for an input that is not a valid table name, snapshot id, tag name or retention. */
export class VersionInputError extends Error {
  readonly code = 'invalid_argument';
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'VersionInputError';
  }
}

const IDENT = /^[a-z_][a-z0-9_]*$/;

/** `catalog.schema.table`, each part a bare lower-case identifier (the names the OS mints). */
export function parseFqn(fqn: string): TableRef {
  const parts = String(fqn ?? '').trim().split('.');
  if (parts.length !== 3 || !parts.every((p) => IDENT.test(p))) {
    throw new VersionInputError(`'${fqn}' is not a catalog.schema.table name`);
  }
  return { catalog: parts[0], schema: parts[1], table: parts[2] };
}

const fq = (t: TableRef) => `${t.catalog}.${t.schema}.${t.table}`;
/** A metadata table: `catalog.schema."table$suffix"` (Trino's documented spelling). */
const meta = (t: TableRef, suffix: 'snapshots' | 'refs' | 'history') => `${t.catalog}.${t.schema}."${t.table}$${suffix}"`;

/** An Iceberg snapshot id: a positive 64-bit integer, carried as a string (it exceeds 2^53). */
export function snapshotId(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!/^[0-9]{1,19}$/.test(s) || BigInt(s) > 9223372036854775807n || BigInt(s) === 0n) {
    throw new VersionInputError(`'${s}' is not an Iceberg snapshot id`);
  }
  return s;
}

/**
 * A tag or branch name. Iceberg allows any string; the OS allows a conservative subset so a name
 * is safe as a SQL string literal and readable in a URL. `main` is Iceberg's own current branch
 * and is never created, moved or removed by the OS.
 */
export function refName(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s)) {
    throw new VersionInputError(`'${s}' is not a valid tag or branch name (letters, digits, '.', '_', '-'; at most 100)`);
  }
  if (s === 'main') throw new VersionInputError("'main' is the table's current branch; it cannot be created or removed");
  return s;
}

/** Which version to read: a snapshot id, or a tag/branch name. */
export type VersionSel = { snapshotId: string } | { ref: string };

/** The `FOR VERSION AS OF` clause for one version (a snapshot id is a number, a ref a string). */
export function versionClause(sel: VersionSel): string {
  if ('snapshotId' in sel) return `FOR VERSION AS OF ${snapshotId(sel.snapshotId)}`;
  // A ref is validated to [A-Za-z0-9._-], so it can never close the literal.
  return `FOR VERSION AS OF '${refName(sel.ref)}'`;
}

/** Every snapshot of the table, newest first. Ids are cast to varchar (a JS number would round them). */
export function snapshotsSql(fqn: string): string {
  const t = parseFqn(fqn);
  return [
    'SELECT CAST(snapshot_id AS varchar) AS snapshot_id,',
    '  CAST(parent_id AS varchar) AS parent_id,',
    "  CAST(to_iso8601(committed_at) AS varchar) AS committed_at,",
    '  operation,',
    "  element_at(summary, 'added-records') AS added_records,",
    "  element_at(summary, 'deleted-records') AS deleted_records,",
    "  element_at(summary, 'total-records') AS total_records,",
    "  element_at(summary, 'trino_query_id') AS trino_query_id,",
    "  element_at(summary, 'trino_user') AS trino_user",
    `FROM ${meta(t, 'snapshots')}`,
    'ORDER BY committed_at DESC',
  ].join('\n');
}

/** Every named version (tags and branches, `main` included), with the snapshot each points to. */
export function refsSql(fqn: string): string {
  const t = parseFqn(fqn);
  return [
    'SELECT name, type, CAST(snapshot_id AS varchar) AS snapshot_id,',
    '  CAST(max_reference_age_in_ms AS varchar) AS max_reference_age_in_ms',
    `FROM ${meta(t, 'refs')}`,
    'ORDER BY name',
  ].join('\n');
}

/** Up to `limit` rows of the table as it was at one version. */
export function readAtVersionSql(fqn: string, sel: VersionSel, limit = 100): string {
  const t = parseFqn(fqn);
  const n = Math.max(1, Math.min(10_000, Math.trunc(Number(limit) || 100)));
  return `SELECT * FROM ${fq(t)} ${versionClause(sel)} LIMIT ${n}`;
}

/**
 * The size of the change from version `a` to version `b`: rows in `b` not in `a` (`added`) and rows
 * in `a` not in `b` (`removed`), as multisets (`EXCEPT ALL`), so a duplicated row counts once per copy.
 * An updated row counts as one removed plus one added.
 */
export function diffCountsSql(fqn: string, a: VersionSel, b: VersionSel): string {
  const t = parseFqn(fqn);
  const A = `SELECT * FROM ${fq(t)} ${versionClause(a)}`;
  const B = `SELECT * FROM ${fq(t)} ${versionClause(b)}`;
  return [
    `SELECT (SELECT count(*) FROM (${B} EXCEPT ALL ${A})) AS added,`,
    `  (SELECT count(*) FROM (${A} EXCEPT ALL ${B})) AS removed`,
  ].join('\n');
}

/** Up to `limit` rows of each side of the change, marked `+` (added in b) or `-` (removed from a). */
export function diffRowsSql(fqn: string, a: VersionSel, b: VersionSel, limit = 50): string {
  const t = parseFqn(fqn);
  const n = Math.max(1, Math.min(1000, Math.trunc(Number(limit) || 50)));
  const A = `SELECT * FROM ${fq(t)} ${versionClause(a)}`;
  const B = `SELECT * FROM ${fq(t)} ${versionClause(b)}`;
  return [
    `(SELECT '+' AS change, d.* FROM (${B} EXCEPT ALL ${A}) d LIMIT ${n})`,
    'UNION ALL',
    `(SELECT '-' AS change, d.* FROM (${A} EXCEPT ALL ${B}) d LIMIT ${n})`,
  ].join('\n');
}

/** Make an earlier snapshot the table's current state again (Trino 476 table procedure). */
export function rollbackSql(fqn: string, id: string): string {
  const t = parseFqn(fqn);
  return `ALTER TABLE ${fq(t)} EXECUTE rollback_to_snapshot(${snapshotId(id)})`;
}

/**
 * The retention for untagged snapshots: `<n>d` or `<n>h`, the literal forms the governed write path
 * admits. Iceberg keeps every snapshot a tag or branch points to regardless of age, so a tagged
 * version is never expired by this.
 */
export function retention(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!/^[0-9]{1,5}[dh]$/.test(s) || /^0+[dh]$/.test(s)) {
    throw new VersionInputError(`invalid snapshot retention '${s}' (use e.g. '7d' or '48h')`);
  }
  return s;
}

/** The configured retention (`OS_ICEBERG_SNAPSHOT_RETENTION`, chart `trino.catalog.iceberg.snapshotRetention`). */
export function configuredRetention(env: Record<string, string | undefined> = process.env): string {
  return retention(env.OS_ICEBERG_SNAPSHOT_RETENTION?.trim() || '7d');
}

/** Expire untagged snapshots older than the retention (Trino 476 table procedure). */
export function expireSnapshotsSql(fqn: string, keep: string): string {
  const t = parseFqn(fqn);
  return `ALTER TABLE ${fq(t)} EXECUTE expire_snapshots(retention_threshold => '${retention(keep)}')`;
}

// ---------------------------------------------------------------------------------- shapes ---

export type SnapshotRow = {
  snapshotId: string;
  parentId: string | null;
  committedAt: string;
  operation: string;
  addedRecords: string | null;
  deletedRecords: string | null;
  totalRecords: string | null;
  trinoQueryId: string | null;
  trinoUser: string | null;
};

export type RefRow = { name: string; type: 'TAG' | 'BRANCH'; snapshotId: string; maxReferenceAgeMs: string | null };

const nul = (v: unknown): string | null => (v === null || v === undefined || v === 'None' || v === 'null' ? null : String(v));

/** Map the rows of {@link snapshotsSql} (columns in that order) to objects. */
export function snapshotRows(rows: unknown[][]): SnapshotRow[] {
  return rows.map((r) => ({
    snapshotId: String(r[0]),
    parentId: nul(r[1]),
    committedAt: String(r[2]),
    operation: String(r[3]),
    addedRecords: nul(r[4]),
    deletedRecords: nul(r[5]),
    totalRecords: nul(r[6]),
    trinoQueryId: nul(r[7]),
    trinoUser: nul(r[8]),
  }));
}

/** Map the rows of {@link refsSql} to objects. */
export function refRows(rows: unknown[][]): RefRow[] {
  return rows.map((r) => ({
    name: String(r[0]),
    type: String(r[1]).toUpperCase() === 'TAG' ? 'TAG' : 'BRANCH',
    snapshotId: String(r[2]),
    maxReferenceAgeMs: nul(r[3]),
  }));
}
