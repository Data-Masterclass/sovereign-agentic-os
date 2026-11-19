/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * FEATURE:    Lockfile evidence — does an app's npm lockfile still describe its manifest?
 * USER STORY: As a Builder approving a software deploy I need "dependencies scanned" to mean the
 *             dependencies THIS tree declares, so a `package.json` edited after its lockfile was
 *             generated can never ride through on the verdict of the old dependency set.
 * ARCHITECTURE:
 *   Trivy resolves npm dependencies from `package-lock.json` and never reads the ranges in
 *   `package.json`. A lockfile that no longer matches its manifest therefore produces a perfectly
 *   well-formed `lang-pkgs` result — over a dependency tree the app does not declare. Presence of a
 *   lockfile is not evidence; AGREEMENT with the manifest is.
 *
 *   PURE and dependency-free (no `server-only`, no fs): `scan-trivy.ts` calls it over the scanned
 *   tree, the scaffold drift test calls it over the committed scaffold lockfiles, and the
 *   regeneration script's output is held to the same predicate. One comparison, three callers, so
 *   "in sync" cannot mean two different things.
 *
 *   WHAT IS COMPARED (npm lockfileVersion 2/3, i.e. a `packages` table):
 *     - the lock's ROOT entry (`packages[""]`) against the manifest beside it: `name`, `version`,
 *       and every range in `dependencies`, `devDependencies`, `optionalDependencies` and
 *       `peerDependencies` — exactly the fields npm copies from the manifest when it resolves;
 *     - that every declared (dev)dependency has a resolution entry (`node_modules/<name>`), so a
 *       root entry edited by hand without resolving is caught;
 *     - a manifest WITHOUT its own lockfile that an ancestor lockfile carries as a local package
 *       (`file:` / workspace — e.g. `vendor/@sovereign-os/ui`) against that entry.
 *
 *   WHAT IT CANNOT SEE, stated so nobody reads more into "consistent" than is there:
 *     - it does not contact a registry, so it cannot prove a resolved version satisfies its range,
 *       nor that an `integrity` hash is genuine. A lockfile forged end to end but internally
 *       consistent passes this check. It proves the lock was written FOR this manifest, not BY npm;
 *     - `yarn.lock` / `pnpm-lock.yaml` and npm lockfileVersion 1 are not parsed (`other-lock`):
 *       coverage for those still rests on the engine's own `lang-pkgs` result, as before;
 *     - other ecosystems (pip, go, cargo, …) are out of scope here.
 */
import type { ScaffoldFile } from '@tabs/software/lib/model';

/** The four manifest fields npm mirrors into the lockfile's root entry. */
const RANGE_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const;
type RangeField = (typeof RANGE_FIELDS)[number];

type Json = Record<string, unknown>;

export type NpmLockState =
  /** A lockfile covers this manifest and agrees with it. */
  | 'consistent'
  /** A lockfile covers this manifest and DISAGREES with it — regenerate the lockfile. */
  | 'stale'
  /** The manifest or its lockfile is not readable JSON / not a lockfile. */
  | 'unreadable'
  /** No npm lockfile covers this manifest. */
  | 'unlocked'
  /** A lockfile this module does not parse sits beside it (yarn / pnpm / npm v1). */
  | 'other-lock';

export type NpmManifestEvidence = {
  /** The `package.json` path, relative to the tree root. */
  manifest: string;
  /** How many dependencies it asks a resolver for (deps + dev + optional; peers are the host's). */
  declared: number;
  /** The npm lockfile that covers it, when one does. */
  lock: string | null;
  state: NpmLockState;
  /** Packages the covering lockfile resolves (0 = it resolves nothing, so there is nothing to scan). */
  resolved: number;
  /** Human-readable differences, most useful first. Empty unless `stale` / `unreadable`. */
  problems: string[];
};

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function parse(content: string): Json | null {
  try {
    const v: unknown = JSON.parse(content);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** A `{name: range}` field as a plain string map; anything else reads as empty. */
function ranges(holder: Json, field: RangeField): Record<string, string> {
  const raw = holder[field];
  const out: Record<string, string> = {};
  if (!isObj(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string') out[k] = v;
  return out;
}

function diffRanges(field: RangeField, want: Record<string, string>, got: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [name, range] of Object.entries(want)) {
    if (!(name in got)) out.push(`${field}: "${name}" (${range}) is declared but absent from the lockfile`);
    else if (got[name] !== range) out.push(`${field}: "${name}" is ${range} in package.json but ${got[name]} in the lockfile`);
  }
  for (const name of Object.keys(got)) {
    if (!(name in want)) out.push(`${field}: "${name}" is in the lockfile but no longer declared`);
  }
  return out;
}

function declaredCount(manifest: Json): number {
  return (
    Object.keys(ranges(manifest, 'dependencies')).length +
    Object.keys(ranges(manifest, 'devDependencies')).length +
    Object.keys(ranges(manifest, 'optionalDependencies')).length
  );
}

/** The lock's `packages` table, or null when this is not a v2/v3 lockfile. */
function packagesOf(lock: Json): Record<string, Json> | null {
  const p = lock.packages;
  if (!isObj(p)) return null;
  const out: Record<string, Json> = {};
  for (const [k, v] of Object.entries(p)) if (isObj(v)) out[k] = v;
  return out;
}

/**
 * Compare a manifest with the ROOT entry of the lockfile beside it. Returns every difference;
 * an empty array means the lockfile was written for exactly this manifest.
 */
export function compareManifestToLock(manifest: Json, lock: Json): string[] {
  const packages = packagesOf(lock);
  if (!packages) return ['the lockfile has no `packages` table (not an npm lockfileVersion 2/3 file)'];
  const root = packages[''];
  if (!root) return ['the lockfile has no root package entry (`packages[""]`)'];

  const out: string[] = [];
  if (typeof manifest.name === 'string' && root.name !== manifest.name) {
    out.push(`name: package.json says "${manifest.name}" but the lockfile was generated for "${String(root.name ?? '')}"`);
  }
  const mv = typeof manifest.version === 'string' ? manifest.version : undefined;
  const lv = typeof root.version === 'string' ? root.version : undefined;
  if (mv !== lv) out.push(`version: package.json says ${mv ?? '(none)'} but the lockfile says ${lv ?? '(none)'}`);

  for (const field of RANGE_FIELDS) out.push(...diffRanges(field, ranges(manifest, field), ranges(root, field)));

  // A root entry can be edited to match by hand; a resolution cannot be conjured the same way.
  // Every declared (dev)dependency must have been RESOLVED — optional ones may legitimately not be.
  for (const field of ['dependencies', 'devDependencies'] as const) {
    for (const name of Object.keys(ranges(manifest, field))) {
      if (!packages[`node_modules/${name}`]) {
        out.push(`${field}: "${name}" is declared but the lockfile holds no resolution for it (node_modules/${name})`);
      }
    }
  }
  return out;
}

/**
 * Compare a manifest with the entry an ANCESTOR lockfile holds for it as a local package
 * (`file:` dependency or workspace). npm records the member's own version and ranges there.
 */
export function compareManifestToLockEntry(manifest: Json, entry: Json): string[] {
  const out: string[] = [];
  const mv = typeof manifest.version === 'string' ? manifest.version : undefined;
  const lv = typeof entry.version === 'string' ? entry.version : undefined;
  if (mv !== lv) out.push(`version: package.json says ${mv ?? '(none)'} but the lockfile says ${lv ?? '(none)'}`);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    out.push(...diffRanges(field, ranges(manifest, field), ranges(entry, field)));
  }
  return out;
}

const NPM_LOCK_NAMES = ['package-lock.json', 'npm-shrinkwrap.json'];
const OTHER_LOCK_NAMES = ['yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];

const dirOf = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const join = (dir: string, name: string): string => (dir ? `${dir}/${name}` : name);

/**
 * For every `package.json` in the tree (outside `node_modules`), say which npm lockfile covers it
 * and whether the two agree. The order follows the tree's, so messages are stable.
 */
export function npmLockEvidence(files: ScaffoldFile[]): NpmManifestEvidence[] {
  const byPath = new Map<string, string>();
  for (const f of files) byPath.set(f.path.replace(/^\.\//, ''), f.content);

  // Parse each npm lockfile once. `null` = present but unreadable.
  const locks = new Map<string, { path: string; json: Json | null }>();
  for (const [path, content] of byPath) {
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!NPM_LOCK_NAMES.includes(name) || path.split('/').includes('node_modules')) continue;
    const dir = dirOf(path);
    // npm prefers a shrinkwrap; either way one lockfile governs a directory.
    if (!locks.has(dir) || name === 'npm-shrinkwrap.json') locks.set(dir, { path, json: parse(content) });
  }

  const out: NpmManifestEvidence[] = [];
  for (const [path, content] of byPath) {
    if (!/(^|\/)package\.json$/.test(path) || path.split('/').includes('node_modules')) continue;
    const dir = dirOf(path);
    const manifest = parse(content);
    if (!manifest) {
      out.push({
        manifest: path,
        declared: 0,
        lock: locks.get(dir)?.path ?? null,
        state: 'unreadable',
        resolved: 0,
        problems: ['package.json is not valid JSON, so what it declares cannot be compared with any lockfile'],
      });
      continue;
    }
    const declared = declaredCount(manifest);

    const own = locks.get(dir);
    if (own) {
      const packages = own.json ? packagesOf(own.json) : null;
      if (!own.json) {
        out.push({ manifest: path, declared, lock: own.path, state: 'unreadable', resolved: 0, problems: [`${own.path} is not valid JSON`] });
      } else if (!packages && own.json.lockfileVersion === 1) {
        // npm < 7: no root entry to compare. Not parsed here; the engine's own result decides.
        out.push({ manifest: path, declared, lock: own.path, state: 'other-lock', resolved: 0, problems: [] });
      } else {
        const problems = compareManifestToLock(manifest, own.json);
        out.push({
          manifest: path,
          declared,
          lock: own.path,
          state: problems.length > 0 ? 'stale' : 'consistent',
          resolved: packages ? Object.keys(packages).filter((k) => k !== '').length : 0,
          problems,
        });
      }
      continue;
    }

    // No lockfile of its own: is it a local package of an ancestor's lockfile?
    let covered = false;
    for (let up = dir; up !== ''; ) {
      up = dirOf(up);
      const anc = locks.get(up);
      const packages = anc?.json ? packagesOf(anc.json) : null;
      const rel = up ? dir.slice(up.length + 1) : dir;
      const entry = packages?.[rel];
      if (anc && packages && entry && entry.link !== true) {
        const problems = compareManifestToLockEntry(manifest, entry);
        out.push({
          manifest: path,
          declared,
          lock: anc.path,
          state: problems.length > 0 ? 'stale' : 'consistent',
          resolved: Object.keys(packages).filter((k) => k !== '').length,
          problems,
        });
        covered = true;
        break;
      }
    }
    if (covered) continue;

    const other = OTHER_LOCK_NAMES.some((n) => byPath.has(join(dir, n)));
    out.push({ manifest: path, declared, lock: null, state: other ? 'other-lock' : 'unlocked', resolved: 0, problems: [] });
  }
  return out;
}
