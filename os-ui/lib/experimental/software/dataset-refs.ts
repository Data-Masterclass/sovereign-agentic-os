/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * DATASET-REFERENCE SCANNER (0.6.97) — an app must only ever reference GRANTED
 * datasets. The root cause of the live `Forbidden: … not granted ds_09qqomar3y`
 * failure was a build hard-coding a dataset id the app was never granted (or was
 * granted at build time then had withdrawn). This pure, dependency-free helper
 * finds the dataset ids a committed tree references so the build/deploy path can
 * warn the moment a reference falls outside `app.grants.data`.
 *
 * Pure + client-safe (no server-only / Next imports) so the unit tests and the
 * commit/deploy seams share the ONE source of truth. It reads code as TEXT — it
 * does not execute it — so it is conservative by design: it matches the concrete
 * ways a dataset id reaches the SDK, and it never invents an id that isn't a literal
 * `ds_…` token in the source.
 */

/** A committed file the scanner reads (path + full source text). */
export type ScannedFile = { path: string; content: string };

/**
 * A dataset id is `ds_` followed by base36 lowercase alphanumerics (the artifacts
 * `id()` shape: `${prefix}_${base36}${base36}`). We require at least 6 trailing
 * chars so we never mistake a short prose word like `ds_x` for an id, and we anchor
 * on a word boundary so `xds_09qqomar3y` (part of another token) is not a match.
 */
const DATASET_ID = /\bds_[a-z0-9]{6,}\b/g;

/**
 * Only scan files that can actually reference a dataset at runtime — source/config,
 * not lockfiles or binary/asset blobs (which could carry incidental `ds_…` substrings
 * and would only add false positives). Kept deliberately broad across code + config.
 */
const SCANNABLE = /\.(tsx?|jsx?|mjs|cjs|json|ya?ml|md)$/i;
const IGNORE_PATH = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i;

function isScannable(path: string): boolean {
  return SCANNABLE.test(path) && !IGNORE_PATH.test(path);
}

/**
 * Every DISTINCT dataset id referenced anywhere in the tree, in first-seen order.
 * This intentionally over-collects (any `ds_…` literal in scannable source counts —
 * `os.datasets.query('ds_…')`, `os.datasets.get('ds_…')`, a `const FOO_DS = 'ds_…'`,
 * or the id in a comment): the caller decides which of these are ungranted, and it is
 * safer to warn about one extra reference than to miss a real ungranted one.
 */
export function referencedDatasetIds(files: ScannedFile[]): string[] {
  const seen = new Set<string>();
  for (const f of files) {
    if (!isScannable(f.path)) continue;
    for (const m of f.content.matchAll(DATASET_ID)) seen.add(m[0]);
  }
  return [...seen];
}

/** A single ungranted reference — the id plus the files it appears in. */
export type UngrantedDatasetRef = { id: string; files: string[] };

/**
 * The dataset ids the tree references that are NOT in `grantedDataIds` — the
 * violations to surface. `grantedDataIds` is the id list from `app.grants.data`
 * (`app.grants.data.map(g => g.id)`). Empty result ⇒ every referenced dataset is
 * granted (the good case). Each entry names the files so the message can point the
 * builder at exactly where to fix or remove the reference.
 */
export function ungrantedDatasetRefs(
  files: ScannedFile[],
  grantedDataIds: readonly string[],
): UngrantedDatasetRef[] {
  const granted = new Set(grantedDataIds);
  const referenced = referencedDatasetIds(files);
  const ungranted = referenced.filter((id) => !granted.has(id));
  if (ungranted.length === 0) return [];
  return ungranted.map((id) => ({
    id,
    files: files.filter((f) => isScannable(f.path) && f.content.includes(id)).map((f) => f.path),
  }));
}

/**
 * How each referenced-but-ungranted id was resolved against the artifacts registry:
 *   • `names[id]` present  → the dataset EXISTS but isn't granted (grant it).
 *   • `deletedIds` has id  → the dataset does NOT exist (deleted) — rebuild/restore.
 *   • neither               → treated like "exists, unnamed" (grant it, bare id).
 */
export type DatasetRefResolution = {
  names?: Readonly<Record<string, string>>;
  deletedIds?: readonly string[];
};

/**
 * The human warning for a set of ungranted dataset references — the SAME message the
 * commit-time diagnostic and the deploy review card surface, so both speak with one
 * voice. It splits the two real causes (mirroring `appGrantDenial`):
 *   • EXISTS-but-ungranted → `«Service Centers» (ds_…)` + "grant it in Context".
 *   • DELETED/nonexistent  → "ds_… no longer exists (deleted)" + "rebuild or restore",
 *     NEVER "grant it" (the id isn't grantable — it's gone).
 * Returns '' when there are no violations.
 */
export function ungrantedDatasetWarning(
  refs: UngrantedDatasetRef[],
  resolution: DatasetRefResolution = {},
): string {
  if (refs.length === 0) return '';
  const names = resolution.names ?? {};
  const deleted = new Set(resolution.deletedIds ?? []);
  const where = (r: UngrantedDatasetRef) => r.files.join(', ') || '(unknown file)';

  const existing = refs.filter((r) => !deleted.has(r.id));
  const gone = refs.filter((r) => deleted.has(r.id));

  const parts: string[] = [];
  if (existing.length > 0) {
    const named = (id: string) => (names[id] ? `«${names[id]}» (${id})` : id);
    parts.push(
      `This app references ${existing.length} dataset${existing.length === 1 ? '' : 's'} it is NOT granted:`,
      existing.map((r) => `  ${named(r.id)} — referenced in ${where(r)}`).join('\n'),
      'Grant each in Context (Software → <app> → Context) or remove the reference from the code.',
    );
  }
  if (gone.length > 0) {
    if (parts.length) parts.push('');
    parts.push(
      `This app references ${gone.length} dataset${gone.length === 1 ? '' : 's'} that NO LONGER EXIST (likely deleted):`,
      gone.map((r) => `  ${r.id} — referenced in ${where(r)}`).join('\n'),
      'These cannot be granted (they are gone) — rebuild the story against a dataset that currently exists, or restore the deleted dataset.',
    );
  }
  return parts.join('\n');
}
