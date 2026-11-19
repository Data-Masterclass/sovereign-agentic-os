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
 *     - that every declared dependency, devDependency and non-optional peer has a resolution
 *       entry (`node_modules/<name>`), so a root entry edited by hand without resolving is caught;
 *     - that each resolved version SATISFIES the range that asked for it ({@link satisfiesRange}),
 *       so `^4.17.21` beside a resolution of 4.17.20 is stale even though both sides "exist";
 *     - a manifest WITHOUT its own lockfile that an ancestor lockfile carries as a local package
 *       (`file:` / workspace — e.g. `vendor/@sovereign-os/ui`) against that entry: version, all
 *       four range fields, and a resolution for each of its dependencies and non-optional peers,
 *       looked up the way Node resolves (its own `node_modules`, then each ancestor's).
 *
 *   WHAT IT CANNOT SEE, stated so nobody reads more into "consistent" than is there:
 *     - it does not contact a registry, so it cannot prove a resolved version EXISTS or that an
 *       `integrity` hash is genuine. A lockfile forged end to end but internally consistent passes
 *       this check. It proves the lock was written FOR this manifest, not BY npm;
 *     - the range check is a deliberately small semver subset (`semver` is not a dependency of
 *       os-ui): exact versions, `^`, `~`, the comparators, x-ranges, hyphen ranges, and `||`. A
 *       range it cannot read (a tag such as `latest`, `npm:` aliases, git/URL/`file:` specifiers)
 *       or a prerelease on either side is NOT judged — it is left alone rather than guessed at.
 *       "Not judged" means NO problem is raised: the pair is ACCEPTED. So a prerelease resolution
 *       (`19.0.0-rc.1`), a Ruby-style `~>`, a bare operator (`^`, `>=`) and a malformed x-range
 *       (`1.x.3`) all pass this particular check. A resolution entry with NO `version` at all is
 *       different: there is nothing to accept, and it is stale;
 *     - a local package's devDependencies are compared as ranges but not required to be resolved:
 *       npm installs them for a workspace member and not for a plain `file:` dependency, and the
 *       lockfile does not say which the entry is;
 *     - `yarn.lock` / `pnpm-lock.yaml` / bun locks and npm lockfileVersion 1 are not parsed
 *       (`other-lock`). Their agreement with the manifest is NOT checked; the entry names the
 *       lockfile so the scanner can at least require a `lang-pkgs` result for THAT file;
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
  /**
   * How many dependencies it names, across ALL FOUR fields. Peers count: npm 7+ installs them, so
   * a peer-only manifest still asks a resolver for packages and is not "nothing to resolve".
   */
  declared: number;
  /** The lockfile that covers it, when one does (for `other-lock`: the yarn / pnpm / v1 file). */
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
  return RANGE_FIELDS.reduce((n, field) => n + Object.keys(ranges(manifest, field)).length, 0);
}

// ------------------------------------------------------------- a small semver ------

type V = [number, number, number];

/** `1.2.3` (optionally `v`-prefixed, optionally with build metadata). Prereleases return null. */
function parseVersion(v: string): V | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmp = (a: V, b: V): number => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** A partial version (`1`, `1.2`, `1.x`, `*`, ``) as its inclusive lower and exclusive upper bound. */
function partial(p: string): { lo: V; hi: V | null; full: boolean } | null {
  const t = p.trim().replace(/^v/, '');
  if (t === '' || t === '*' || t === 'x' || t === 'X') return { lo: [0, 0, 0], hi: null, full: false };
  const m = /^(\d+)(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?$/.exec(t);
  if (!m) return null;
  const major = Number(m[1]);
  const wild = (x: string | undefined) => x === undefined || /^[xX*]$/.test(x);
  // `1.x.3` is not a range anything defines — a wildcard followed by a number is malformed.
  if (wild(m[2]) && m[3] !== undefined && !wild(m[3])) return null;
  if (wild(m[2])) return { lo: [major, 0, 0], hi: [major + 1, 0, 0], full: false };
  const minor = Number(m[2]);
  if (wild(m[3])) return { lo: [major, minor, 0], hi: [major, minor + 1, 0], full: false };
  return { lo: [major, minor, Number(m[3])], hi: null, full: true };
}

/** One comparator (`^1.2.3`, `>=2`, `1.x`, …) against a version. null = not a form we read. */
function testComparator(v: V, c: string): boolean | null {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.*)$/.exec(c.trim());
  if (!m) return null;
  const op = m[1] ?? '';
  // A bare operator (`^`, `~`, `>=`) names no version. It must not read as "anything satisfies".
  if (op !== '' && m[2].trim() === '') return null;
  const p = partial(m[2]);
  if (!p) return null;
  const { lo, hi, full } = p;
  switch (op) {
    case '^': {
      // Up to, not including, the next change of the left-most non-zero component.
      const upper: V = lo[0] > 0 ? [lo[0] + 1, 0, 0] : lo[1] > 0 ? [0, lo[1] + 1, 0] : full ? [0, 0, lo[2] + 1] : (hi ?? [1, 0, 0]);
      return cmp(v, lo) >= 0 && cmp(v, upper) < 0;
    }
    case '~': {
      const upper: V = full || m[2].split('.').length >= 2 ? [lo[0], lo[1] + 1, 0] : [lo[0] + 1, 0, 0];
      return cmp(v, lo) >= 0 && cmp(v, upper) < 0;
    }
    case '>=':
      return cmp(v, lo) >= 0;
    case '>':
      return full ? cmp(v, lo) > 0 : hi === null ? false : cmp(v, hi) >= 0;
    case '<':
      return cmp(v, lo) < 0;
    case '<=':
      return full ? cmp(v, lo) <= 0 : hi === null ? true : cmp(v, hi) < 0;
    default:
      // `=` or bare: an exact version, or an x-range.
      return full ? cmp(v, lo) === 0 : cmp(v, lo) >= 0 && (hi === null || cmp(v, hi) < 0);
  }
}

/**
 * Does `version` satisfy the npm `range`? `true` / `false` when this module can tell, `null` when
 * it cannot and therefore must not judge: a non-semver specifier (tag, alias, git, URL, `file:`,
 * `workspace:`), a prerelease on either side, or a syntax outside the subset described above.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const v = parseVersion(version);
  if (!v) return null;
  const r = range.trim();
  if (/[a-zA-Z]:|\/|^[a-zA-Z][\w-]*$/.test(r) && !/^[xX]$/.test(r)) return null; // alias / url / path / tag
  if (/\d-[0-9A-Za-z]/.test(r.replace(/\s-\s/g, ' '))) return null; // a prerelease inside the range
  let any = false;
  for (const alt of r.split('||')) {
    const hyphen = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt);
    // npm allows a space between an operator and its version (`>= 3.1.0 < 4`): rejoin them first.
    const joined = alt.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1');
    const parts = hyphen ? [`>=${hyphen[1]}`, `<=${hyphen[2]}`] : joined.split(/\s+/).filter(Boolean);
    let all = true;
    for (const c of parts.length > 0 ? parts : ['*']) {
      const t = testComparator(v, c);
      if (t === null) return null;
      if (!t) all = false;
    }
    if (all) any = true;
  }
  return any;
}

/** Peers npm will not install: those a manifest marks `optional` in `peerDependenciesMeta`. */
function optionalPeers(holder: Json): Set<string> {
  const meta = holder.peerDependenciesMeta;
  const out = new Set<string>();
  if (isObj(meta)) for (const [k, v] of Object.entries(meta)) if (isObj(v) && v.optional === true) out.add(k);
  return out;
}

/**
 * Where a dependency of the package at `from` ('' = the root) is resolved: its own
 * `node_modules`, then each ancestor directory's — Node's own lookup.
 */
function resolutionOf(packages: Record<string, Json>, from: string, name: string): Json | null {
  for (let dir = from; ; dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '') {
    const hit = packages[dir ? `${dir}/node_modules/${name}` : `node_modules/${name}`];
    if (hit) return hit;
    if (dir === '') return null;
  }
}

/**
 * Every name in `fields` must be RESOLVED, and resolved to a version its range accepts. A link
 * entry (`file:` / workspace) is followed to its target for the version.
 */
function resolutionProblems(
  packages: Record<string, Json>,
  from: string,
  holder: Json,
  fields: readonly RangeField[],
): string[] {
  const out: string[] = [];
  const skipPeers = optionalPeers(holder);
  for (const field of fields) {
    for (const [name, range] of Object.entries(ranges(holder, field))) {
      if (field === 'peerDependencies' && skipPeers.has(name)) continue;
      let hit = resolutionOf(packages, from, name);
      if (!hit) {
        if (field === 'optionalDependencies') continue; // may legitimately be absent on this platform
        out.push(`${field}: "${name}" is declared but the lockfile holds no resolution for it (node_modules/${name})`);
        continue;
      }
      if (hit.link === true && typeof hit.resolved === 'string') hit = packages[hit.resolved] ?? hit;
      const version = typeof hit.version === 'string' ? hit.version : null;
      if (!version) {
        // npm records a version for every installed package. An entry without one resolves
        // nothing a scanner could look up — a placeholder, not a resolution.
        out.push(`${field}: "${name}" has a lockfile entry with no version, so nothing was actually resolved for it`);
        continue;
      }
      if (satisfiesRange(version, range) === false) {
        out.push(`${field}: "${name}" asks for ${range} but the lockfile resolves ${version}, which does not satisfy it`);
      }
    }
  }
  return out;
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
  // Every declared name must have been RESOLVED, to a version its range accepts.
  out.push(...resolutionProblems(packages, '', manifest, RANGE_FIELDS));
  return out;
}

/**
 * Compare a manifest with the entry an ANCESTOR lockfile holds for it as a local package
 * (`file:` dependency or workspace). npm records the member's own version and ranges there.
 */
export function compareManifestToLockEntry(
  manifest: Json,
  entry: Json,
  where?: { packages: Record<string, Json>; path: string },
): string[] {
  const out: string[] = [];
  const mv = typeof manifest.version === 'string' ? manifest.version : undefined;
  const lv = typeof entry.version === 'string' ? entry.version : undefined;
  if (mv !== lv) out.push(`version: package.json says ${mv ?? '(none)'} but the lockfile says ${lv ?? '(none)'}`);
  for (const field of RANGE_FIELDS) out.push(...diffRanges(field, ranges(manifest, field), ranges(entry, field)));
  // Its dependencies must be resolved too — a `file:` package that gained a dependency the lock
  // never resolved is exactly a manifest the lock no longer describes. devDependencies are
  // compared above but not REQUIRED here (see the header: workspace member vs plain `file:`).
  if (where) {
    out.push(...resolutionProblems(where.packages, where.path, manifest, ['dependencies', 'optionalDependencies', 'peerDependencies']));
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
        const problems = compareManifestToLockEntry(manifest, entry, { packages, path: rel });
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

    const other = OTHER_LOCK_NAMES.map((n) => join(dir, n)).find((p) => byPath.has(p));
    out.push({ manifest: path, declared, lock: other ?? null, state: other ? 'other-lock' : 'unlocked', resolved: 0, problems: [] });
  }
  return out;
}
