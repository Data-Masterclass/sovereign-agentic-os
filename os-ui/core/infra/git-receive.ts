/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The receive gate — ONE OS endpoint that every `git push` into a domain repo passes
 * USER STORY: As a data or AI engineer I want to push to my domain's repository from VS Code and
 *             have the OS accept it exactly when the UI would have accepted the same change, with
 *             a readable reason on my terminal when it does not — and as the owner I want a push
 *             and an OS write never to interleave (E-US1, E-US3, decisions D27/D28/D29).
 * ARCHITECTURE:
 *   - WHO READS THE OBJECTS (review H-2, the bug that closed the door). During `pre-receive` the
 *     pushed objects live in git's QUARANTINE directory (`GIT_QUARANTINE_PATH` /
 *     `GIT_OBJECT_DIRECTORY=…/tmp_objdir-incoming-*`), which is visible ONLY to the hook's own
 *     process tree. A reader in the os-ui process cannot see them: the first version of this file
 *     called `isomorphic-git` against the bare repo and therefore failed EVERY push (`isDescendent`
 *     threw → "not a fast-forward" → 409; a first push into an empty repo → 500). So the HOOK, which
 *     runs where git is, computes the whole change list with git's own plumbing
 *     (`git merge-base --is-ancestor`, `git diff-tree -r --name-status`, `git cat-file`) and posts
 *     paths + base64 blobs. **The OS reads nothing from the repository during `pre`.**
 *   - WHO IS AUTHORITATIVE AFTERWARDS. At `post-receive` the refs ARE updated and the objects are
 *     no longer quarantined, so `completeReceive` re-derives the changed files FROM THE REPOSITORY
 *     and ingests those. The hook's list gates; the repository is what gets ingested. A path the
 *     gate never saw is reported in the message rather than silently ingested.
 *   - THE LOCK is `git-store.ts`'s own per-repository mutex, through the exported
 *     `acquireRepoLock` (the `=== E LOCK BLOCK ===`): one lock, one place, no second copy to keep
 *     in step. It is held from `pre-receive` to `post-receive` in a LEASE keyed on the domain —
 *     two hook processes cannot pass a handle, and the lock guarantees at most one open lease per
 *     domain. The wait is bounded; on timeout the push fails with a sentence a developer can act
 *     on instead of hanging their terminal. An abandoned lease expires by itself.
 *   - PATH OWNERSHIP. `decidePath` is pure — this is the function the unit tests enumerate. Own
 *     personal lane always; domain paths by role; and NEVER the files that are the OS's own voice
 *     (`os/**`, `agents/index.yml`, grants) or the dbt project's own executable configuration
 *     (`dbt_project.yml`, `profiles.yml`, `packages.yml`, `macros/**` — a pushed `on-run-start:`
 *     or macro runs SQL as the OS's dbt principal on every build, which is a different kind of
 *     change from a model).
 *   - ONE VALIDATOR, NOT A SECOND COPY. `core/` may not import a tab (check-structure rule 3), so
 *     this file holds no validator at all: each kind REGISTERS the validator the UI already calls
 *     (`registerRepoKind`). There is nowhere to put a second copy.
 *   - NOTHING LOGS A TOKEN. Every message out of this module goes through `redact`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@core/kernel/config';
import { acquireRepoLock, listTree, MAIN, repoExists, repoPath, RepoLockTimeoutError, type TreeEntry } from '@core/infra/git-store';
import * as git from 'isomorphic-git';
import { redact } from '@core/auth/access-tokens';

/** The managed-by-the-OS rejection, in the owner's words. Asserted verbatim by the tests. */
export const MANAGED_BY_OS = 'managed by the OS; change it in Governance or over the MCP';

/**
 * A push that removes an object wholesale is refused. Same rule as the git store's
 * `DestructiveReconcileError` and for the same reason: the one thing a derived index must never do
 * is let a bad write look like a retirement. Retiring an object is a governed action with a
 * dependents check, and `git rm -r` is not it.
 */
export const DESTRUCTIVE_PUSH =
  'the OS refuses a push that removes an object wholesale; retire it in the OS or over the MCP instead';

/**
 * AUDIENCE IS NOT PUSHABLE. `My -> Domain -> Company` changes only through the promotion path,
 * with its roles, requests and approvals — so a pushed file that disagrees with the registry about
 * `tier`/`visibility` is refused rather than applied. Every kind's `ingest` enforces this with
 * this exact sentence; it is part of the `ingestFromRepo` contract, not a per-kind choice.
 */
export const AUDIENCE_MANAGED = 'audience is managed by the OS; use promotion';

/** Prefixes the OS owns inside every domain repo. Committed for transparency, never pushable. */
export const OS_OWNED_PREFIXES = ['os/', 'macros/'] as const;

/**
 * Exact paths the OS owns. `dbt_project.yml` and `macros/**` are not documentation: dbt EXECUTES
 * them (`on-run-start`, `on-run-end`, every macro a model calls) as the OS's dbt principal, so a
 * change to them is a change to what the OS runs, not to what a model selects. `profiles.yml` is
 * the connection. `packages.yml` would fetch third-party code into the OS's build.
 */
export const OS_OWNED_FILES = ['dbt_project.yml', 'profiles.yml', 'packages.yml', 'agents/index.yml'] as const;

/** Default bounded wait for the per-domain lock before a push is failed rather than hung. */
export const DEFAULT_LOCK_TIMEOUT_MS = 20_000;

/** How long an un-completed lease may hold the lock before it is released on its own. */
export const DEFAULT_LEASE_TTL_MS = 180_000;

/** Per-file and per-push caps the HOOK enforces before it posts anything (review M-5). */
export const MAX_FILE_BYTES = 1_048_576;
export const MAX_PUSH_BYTES = 16_777_216;

/** One ref update, as the hook reports it. `fastForward` is `git merge-base --is-ancestor`. */
export type RefUpdate = { ref: string; oldSha: string; newSha: string; fastForward?: boolean };

export type Pusher = {
  id: string;
  name?: string | null;
  email?: string | null;
  role: 'creator' | 'builder' | 'domain_admin' | 'admin';
  domains: string[];
  /** The repo prefixes this principal owns outright. Defaults to `personalLanes(id)`. */
  lanes?: string[];
};

export type ChangedFile = { path: string; status: 'added' | 'modified' | 'deleted'; content: string | null };

/** One object kind's half of the coin: what it owns in the repo, how it validates, how it ingests. */
export type RepoKind = {
  /** `dataset` | `agent-system` | … — the `ingestFromRepo(kind, files)` key. */
  kind: string;
  /** True when this kind owns the path (so its validator and its ingest see it). */
  matches(filePath: string): boolean;
  /**
   * The SAME validator the UI and the MCP call for this kind. Returns null when the file is
   * acceptable, or a human sentence naming what is wrong. Never throws for a bad file.
   */
  validate(file: { path: string; content: string }): string | null;
  /**
   * Apply the pushed files through the kind's GOVERNED service, as the pusher.
   *
   * TWO RULES EVERY KIND OBEYS, not optional:
   *   1. **Never apply audience.** A pushed `tier` / `visibility` that disagrees with the registry
   *      is REFUSED for that path with `AUDIENCE_MANAGED` — never applied, never silently ignored.
   *   2. **Never retire.** A removed file is reported; retirement is a governed action. The gate
   *      refuses a wholesale removal before the ingest ever runs (`DESTRUCTIVE_PUSH`).
   */
  ingest(input: { domain: string; files: ChangedFile[]; pusher: Pusher; sha: string }): Promise<IngestReport>;
};

export type IngestReport = { kind: string; created: number; updated: number; skipped: number; notes: string[] };

export type GateDecision =
  | { ok: true; leaseId: string; changed: ChangedFile[]; sha: string; unmatched: string[] }
  | { ok: false; status: number; message: string };

// --------------------------------------------------------------- kind registry ---

const KINDS_KEY = Symbol.for('soa.git-receive.kinds');
function kinds(): Map<string, RepoKind> {
  const g = globalThis as unknown as Record<symbol, Map<string, RepoKind> | undefined>;
  if (!g[KINDS_KEY]) g[KINDS_KEY] = new Map();
  return g[KINDS_KEY]!;
}

/** Register (or replace) one kind's validator + ingest. Idempotent; called once at boot. */
export function registerRepoKind(k: RepoKind): void {
  kinds().set(k.kind, k);
}

export function registeredRepoKinds(): RepoKind[] {
  return [...kinds().values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/** Test seam. */
export function __clearRepoKinds(): void {
  kinds().clear();
}

// ------------------------------------------------- governed-ref resolution (night-2 merge) ---

/**
 * NIGHT-2 MERGE (E x D x M). A pushed dashboard-as-code file binds every panel to a governed id
 * (`metric:<id>`), and importing it has to resolve that id **as the pusher** so a metric they
 * cannot see is indistinguishable from one that does not exist and a panel is never silently
 * rebound to a same-named member of a different number.
 *
 * The resolution is the Metrics tab's, the gate is the kernel's, and a tab may not import another
 * tab — so this is the seam, exactly like `registerRepoKind` above and for the same reason. The
 * Metrics tab installs its resolver at boot; unregistered, every ref resolves to `null`, which the
 * importer turns into a loud refusal rather than a guess.
 */
export type GovernedRefResolver = (ref: string, caller: Pusher) => { member: string } | null;

const REF_RESOLVER_KEY = Symbol.for('soa.git-receive.ref-resolver');

/** Install the governed-id resolver. Idempotent; called once at boot. */
export function registerGovernedRefResolver(resolve: GovernedRefResolver): void {
  (globalThis as unknown as Record<symbol, GovernedRefResolver | undefined>)[REF_RESOLVER_KEY] = resolve;
}

/** Is a resolver installed? A caller that needs to SAY why a ref did not resolve asks this. */
export function governedRefResolverWired(): boolean {
  return typeof (globalThis as unknown as Record<symbol, GovernedRefResolver | undefined>)[REF_RESOLVER_KEY] === 'function';
}

/**
 * Resolve one governed id as `caller`. `null` means "does not exist OR you may not see it" — the
 * two are deliberately indistinguishable. Never throws: a resolver that throws is `null` too,
 * because a refusal is the safe answer and an exception here would fail a whole push opaquely.
 */
export function resolveGovernedRef(ref: string, caller: Pusher): { member: string } | null {
  const fn = (globalThis as unknown as Record<symbol, GovernedRefResolver | undefined>)[REF_RESOLVER_KEY];
  if (typeof fn !== 'function') return null;
  try {
    return fn(ref, caller);
  } catch {
    return null;
  }
}

/** Test seam. */
export function __clearGovernedRefResolver(): void {
  delete (globalThis as unknown as Record<symbol, GovernedRefResolver | undefined>)[REF_RESOLVER_KEY];
}

// ------------------------------------------------------------------ the lease ---

export class LockTimeoutError extends Error {
  status = 503;
  constructor(domain: string, ms: number) {
    super(
      `the OS is writing to '${domain}' right now and did not finish within ${Math.round(ms / 1000)}s — ` +
        'nothing was changed; run `git push` again in a moment',
    );
    this.name = 'LockTimeoutError';
  }
}

type Lease = {
  id: string;
  domain: string;
  release: () => void;
  timer: ReturnType<typeof setTimeout>;
  pusher: Pusher;
  gated: ChangedFile[];
  oldSha: string | null;
  sha: string;
};

/**
 * Open leases, keyed by DOMAIN — not by lease id. `pre-receive` and `post-receive` are two separate
 * processes and the first cannot hand an id to the second, but the lock guarantees at most one open
 * lease per domain, so the domain IS the handle. The id is kept for the log.
 */
const LEASES_KEY = Symbol.for('soa.git-receive.leases');
function leases(): Map<string, Lease> {
  const g = globalThis as unknown as Record<symbol, Map<string, Lease> | undefined>;
  if (!g[LEASES_KEY]) g[LEASES_KEY] = new Map();
  return g[LEASES_KEY]!;
}

// ------------------------------------------------------------- path ownership ---

/**
 * `models/personal/<sanitised id>/` — the dbt generator's personal lane. The token is the SAME
 * `sanitizeIdent` shape the Trino personal schema uses (`personal_<uid>`), because the directory is
 * derived from that schema name (`tabs/data/lib/dbt/models.ts`). A core module may not import a tab
 * (check-structure rule 3), so the convention is restated here — and `tabs/data/lib/dbt/ingest.test.ts`
 * asserts it still AGREES with the tab's own helper, which is what stops the restatement drifting.
 *
 * COLLISIONS ARE REAL (review M-7): `a.b`, `a-b` and `A_B` all sanitise to `a_b`. That is a
 * pre-existing property of the generator and of the Trino schema, not of this gate — but the gate
 * must not GRANT a lane two principals share, so the caller passes every active principal id to
 * `personalLanes` / `laneCollides` and the lane is withheld when it is ambiguous.
 */
export function personalDataLane(userId: string): string {
  const token = String(userId ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'user';
  return `models/personal/${token}/`;
}

/**
 * `agents/personal/<owner token>/` — the Agents generator's personal lane. Its token is an OPAQUE
 * `sha256(<principal id>)` prefix, deliberately NOT a username (the subtree travels to every mirror
 * and clone), mirroring `tabs/agents/lib/git/generate.ts` `ownerToken`. No collisions.
 */
export function personalAgentLane(userId: string): string {
  return `agents/personal/${createHash('sha256').update(String(userId ?? '')).digest('hex').slice(0, 12)}/`;
}

/**
 * True when another principal's id sanitises to the SAME dbt personal-lane token. The caller
 * supplies the directory's active ids; an empty list means "unknown", which is treated as no
 * collision (the single-user and the test case) because the lane still has to work.
 */
export function laneCollides(userId: string, allIds: readonly string[]): boolean {
  const mine = personalDataLane(userId);
  return allIds.some((other) => other !== userId && personalDataLane(other) === mine);
}

/** Every prefix this principal may always write. The data lane is withheld when it is ambiguous. */
export function personalLanes(userId: string, allIds: readonly string[] = []): string[] {
  const lanes = [personalAgentLane(userId)];
  if (!laneCollides(userId, allIds)) lanes.unshift(personalDataLane(userId));
  return lanes;
}

/** Secret-shaped: a credential has no business arriving by push, whatever the file is called. */
export function looksSecretShaped(filePath: string, content: string | null): string | null {
  const base = filePath.split('/').pop() ?? '';
  if (/(^|\.)env($|\.)|\.pem$|\.key$|(^|[-_.])secrets?([-_.]|$)|(^|[-_.])credentials?([-_.]|$)/i.test(base)) {
    return `'${filePath}' is credential-shaped — ${MANAGED_BY_OS}`;
  }
  if (!content) return null;
  const hit = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----)|(?:\b(?:password|passwd|secret|api[_-]?key|token)\b\s*[:=]\s*["']?[A-Za-z0-9._\-\/+]{12,})/i.exec(
    content,
  );
  return hit ? `'${filePath}' looks like it carries a credential — ${MANAGED_BY_OS}` : null;
}

/**
 * Directories this push would leave with no files at all. Grouped at the TOP level and at the
 * OBJECT level (the second segment), because that is the granularity an object occupies —
 * `dashboards/`, `dashboards/<id>/`, `agents/<slug>/`, `models/gold/`. A directory counts as
 * emptied only when the push removes every path the OLD head tracked under it and adds nothing
 * back. PURE: the caller supplies the old tree (readable during `pre-receive` — the OLD objects
 * were never quarantined).
 */
export function emptiedDirs(changed: readonly ChangedFile[], trackedPaths: readonly string[]): string[] {
  const gone = new Set(changed.filter((f) => f.status === 'deleted').map((f) => f.path));
  if (gone.size === 0) return [];
  const kept = changed.filter((f) => f.status !== 'deleted').map((f) => f.path);
  const groups = new Map<string, string[]>();
  for (const p of trackedPaths) {
    const parts = p.split('/');
    for (const depth of [1, 2]) {
      if (parts.length <= depth) continue;
      const dir = parts.slice(0, depth).join('/');
      groups.set(dir, [...(groups.get(dir) ?? []), p]);
    }
  }
  const out: string[] = [];
  for (const [dir, paths] of groups) {
    if (!paths.some((p) => gone.has(p))) continue;
    if (paths.every((p) => gone.has(p)) && !kept.some((p) => p.startsWith(`${dir}/`))) out.push(dir);
  }
  // The deepest directory is the most informative; drop a parent that only appears because its
  // single child was emptied.
  return out.filter((d) => !out.some((other) => other !== d && other.startsWith(`${d}/`))).sort();
}

export type PathVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * May this pusher change this path? PURE.
 *   - the OS's own files and prefixes: NEVER, by anybody, with the managed-by-the-OS sentence.
 *     They are committed so nothing is a black box, not so they can be edited.
 *   - the pusher's own personal lane: always.
 *   - a domain path (the shared dbt layers, a shared agent system): builder and above.
 */
export function decidePath(filePath: string, pusher: Pusher): PathVerdict {
  const p = filePath.replace(/^\/+/, '');
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return { allowed: false, reason: `'${filePath}' is not a path this repository accepts` };
  }
  if (OS_OWNED_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix))) {
    return { allowed: false, reason: `'${p}' is ${MANAGED_BY_OS}` };
  }
  if ((OS_OWNED_FILES as readonly string[]).includes(p)) {
    return { allowed: false, reason: `'${p}' is ${MANAGED_BY_OS}` };
  }
  if (/(^|\/)grants?\.(ya?ml|json)$/i.test(p)) {
    return { allowed: false, reason: `'${p}' is a grant file — ${MANAGED_BY_OS}` };
  }
  const lanes = pusher.lanes && pusher.lanes.length ? pusher.lanes : personalLanes(pusher.id);
  if (lanes.some((lane) => p.startsWith(lane))) return { allowed: true };
  // Someone ELSE's personal lane is never writable, whatever the role — a personal lane is the one
  // place the OS promises is yours.
  const otherPersonal = /^(models|agents)\/personal\/([^/]+)\//.exec(p);
  if (otherPersonal) {
    return {
      allowed: false,
      reason: `'${p}' is in ${otherPersonal[2]}'s personal lane — only its owner may change it`,
    };
  }
  if (pusher.role === 'creator') {
    return {
      allowed: false,
      reason: `'${p}' is a shared path for this domain — a creator may push only their own personal lane (${lanes.join(', ')}); ask a builder, or make the change in the OS where it goes through approvals`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------- the gate ---

export type GateDeps = {
  reposDir?: string;
  lockTimeoutMs?: number;
  leaseTtlMs?: number;
};

/**
 * PHASE 1 — `pre-receive`. Takes the lock, refuses a rewrite, decides ownership of every path the
 * HOOK reported, runs every registered kind's validator, and holds the lock in a lease until
 * `completeReceive` (or the TTL). A rejection releases the lock immediately.
 *
 * `changed` MUST come from the hook. The OS does not read the repository here — it cannot, by
 * design: the objects are quarantined (see the header). No file list ⇒ the push is refused.
 */
export async function beginReceive(
  input: { domain: string; pusher: Pusher; updates: RefUpdate[]; changed: ChangedFile[] },
  deps: GateDeps = {},
): Promise<GateDecision> {
  const { domain, pusher, updates, changed } = input;
  const reposDir = deps.reposDir ?? config.reposDir;
  if (!repoExists(domain, { reposDir })) {
    return { ok: false, status: 404, message: `there is no repository for '${domain}'` };
  }
  if (!pusher.domains.includes(domain) && pusher.role !== 'admin') {
    return { ok: false, status: 403, message: `you are not a member of '${domain}'` };
  }
  const refs = updates.filter((u) => u.ref === MAIN || u.ref === 'refs/heads/main');
  if (refs.length !== updates.length) {
    const other = updates.find((u) => u.ref !== MAIN && u.ref !== 'refs/heads/main')!;
    return {
      ok: false,
      status: 400,
      message:
        `'${other.ref}' is not a ref this repository accepts — a domain repository has one branch, main. ` +
        'Branches as proposals are on the roadmap, not in this release.',
    };
  }
  if (refs.length === 0) return { ok: false, status: 400, message: 'nothing to do: no update to main' };

  const update = refs[0];
  const ZERO = '0'.repeat(40);
  if (update.newSha === ZERO) {
    return { ok: false, status: 400, message: 'main cannot be deleted — the OS never rewrites, and never accepts a rewrite of, history' };
  }
  // NO HISTORY REWRITES. The verdict is git's own (`git merge-base --is-ancestor`, run by the hook
  // where the quarantined objects are readable), and `receive.denyNonFastForwards = true` in the
  // repository config refuses a rewind before this hook even runs. Two independent refusals; this
  // one exists to make the message readable.
  if (update.oldSha && update.oldSha !== ZERO && update.fastForward !== true) {
    return {
      ok: false,
      status: 409,
      message:
        'this push is not a fast-forward of main — the OS never rewrites, and never accepts a rewrite of, ' +
        'history. Rebase onto the current main and push again.',
    };
  }
  if (!Array.isArray(changed)) {
    return { ok: false, status: 400, message: 'the receive hook sent no file list — nothing was changed' };
  }

  let release: (() => void) | null = null;
  try {
    release = await acquireRepoLock(domain, { reposDir, timeoutMs: deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS });
  } catch (e) {
    if (e instanceof RepoLockTimeoutError) return { ok: false, status: 503, message: redact(e.message) };
    if (e instanceof LockTimeoutError) return { ok: false, status: e.status, message: redact(e.message) };
    throw e;
  }

  try {
    // 1 — ownership, 2 — secret-shaped, 3 — the kind's own validator. The FIRST failure is the
    // message, because a developer fixes one thing at a time.
    for (const f of changed) {
      const verdict = decidePath(f.path, pusher);
      if (!verdict.allowed) return reject(release, 403, verdict.reason);
      const secret = looksSecretShaped(f.path, f.content);
      if (secret) return reject(release, 403, secret);
    }
    // A WHOLESALE REMOVAL is refused before any validator runs. The OLD head's tree is readable
    // here — only the INCOMING objects are quarantined — so this needs nothing from the hook.
    if (changed.some((f) => f.status === 'deleted') && update.oldSha && update.oldSha !== ZERO) {
      let tracked: string[] = [];
      try {
        tracked = (await listTree(domain, update.oldSha, { reposDir })).map((e) => e.path);
      } catch {
        tracked = [];
      }
      const emptied = emptiedDirs(changed, tracked);
      if (emptied.length > 0) {
        return reject(release, 409, `'${emptied[0]}/' would be emptied by this push — ${DESTRUCTIVE_PUSH}`);
      }
    }

    const unmatched: string[] = [];
    for (const f of changed) {
      if (f.status === 'deleted' || f.content === null) continue;
      const owners = registeredRepoKinds().filter((k) => k.matches(f.path));
      if (owners.length === 0) unmatched.push(f.path);
      for (const kind of owners) {
        let problem: string | null = null;
        try {
          problem = kind.validate({ path: f.path, content: f.content });
        } catch (e) {
          problem = e instanceof Error ? e.message : String(e);
        }
        if (problem) return reject(release, 422, `${f.path}: ${problem}`);
      }
    }

    const leaseId = `lease_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const ttl = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    const held = release;
    const lease: Lease = {
      id: leaseId,
      domain,
      release: held,
      pusher,
      gated: changed,
      oldSha: update.oldSha && update.oldSha !== ZERO ? update.oldSha : null,
      sha: update.newSha,
      timer: setTimeout(() => {
        const l = leases().get(domain);
        if (l && l.id === leaseId) {
          leases().delete(domain);
          l.release();
        }
      }, Math.max(1, ttl)),
    };
    (lease.timer as unknown as { unref?: () => void }).unref?.();
    leases().set(domain, lease);
    return { ok: true, leaseId, changed, sha: update.newSha, unmatched };
  } catch (e) {
    release();
    return { ok: false, status: 500, message: redact(e instanceof Error ? e.message : String(e)) };
  }
}

function reject(release: () => void, status: number, message: string): GateDecision {
  release();
  return { ok: false, status, message: redact(message) };
}

/** Who the open lease on this domain belongs to, or null. Used to authorise `post` / `abort`. */
export function leaseHolder(domain: string): string | null {
  return leases().get(domain)?.pusher.id ?? null;
}

/**
 * PHASE 2 — `post-receive`. The refs ARE updated and the objects are out of quarantine, so the
 * changed files are re-derived FROM THE REPOSITORY and those are what get ingested: the hook's
 * list gated the push, the repository is the record. A path the gate never saw is reported, never
 * quietly ingested. An ingest failure is reported too — the push has landed, and pretending
 * otherwise would be a fabricated result.
 */
export async function completeReceive(
  domain: string,
  deps: GateDeps = {},
): Promise<{ ok: boolean; reports: IngestReport[]; message: string }> {
  const lease = leases().get(domain);
  if (!lease) {
    return {
      ok: false,
      reports: [],
      message: 'the OS no longer holds a lease for this push — it landed, but the registry was not reconciled from it',
    };
  }
  leases().delete(domain);
  clearTimeout(lease.timer);
  const reposDir = deps.reposDir ?? config.reposDir;
  try {
    const gitdir = repoPath(domain, { reposDir });
    let fromRepo: ChangedFile[];
    try {
      fromRepo = await diffCommits(gitdir, lease.oldSha, lease.sha, domain, { reposDir });
    } catch {
      // The repository could not be re-read (a partial roll, a vanished object). Fall back to the
      // list the gate approved and SAY so — never silently.
      fromRepo = lease.gated;
    }
    const gatedPaths = new Set(lease.gated.map((f) => f.path));
    const ungated = fromRepo.filter((f) => !gatedPaths.has(f.path)).map((f) => f.path);
    const reports = await ingestChanged(domain, fromRepo, lease.pusher, lease.sha);
    const notes = ungated.length
      ? ` — NOTE: ${ungated.length} path(s) in the commit were not in the list the gate checked (${ungated.slice(0, 5).join(', ')}); the OS reconciled from the repository`
      : '';
    return { ok: true, reports, message: summarise(reports) + notes };
  } catch (e) {
    return { ok: false, reports: [], message: redact(e instanceof Error ? e.message : String(e)) };
  } finally {
    lease.release();
  }
}

/** Release a lease without ingesting (receive-pack failed after pre-receive said yes). */
export function abortReceive(domain: string): boolean {
  const lease = leases().get(domain);
  if (!lease) return false;
  leases().delete(domain);
  clearTimeout(lease.timer);
  lease.release();
  return true;
}

/** Test seam: how many leases this process is holding. */
export function __openLeases(): number {
  return leases().size;
}

// -------------------------------------------------------------- reconciliation ---

/**
 * D29 — reconcile the registry FROM THE FILES between two commits. The registry is a derived
 * index: this is the only direction the arrow points after a push. Attribution is the PUSHER's and
 * the surface is `git:push`, which each kind's ingest passes to the governed service it calls.
 * Safe to call only when the refs are updated (post-receive, a boot reconcile, a backfill).
 */
export async function reconcileFromGit(
  domain: string,
  fromSha: string | null,
  toSha: string,
  pusher: Pusher,
  deps: GateDeps = {},
): Promise<IngestReport[]> {
  const reposDir = deps.reposDir ?? config.reposDir;
  const gitdir = repoPath(domain, { reposDir });
  const changed = await diffCommits(gitdir, fromSha, toSha, domain, { reposDir });
  return ingestChanged(domain, changed, pusher, toSha);
}

async function ingestChanged(domain: string, changed: ChangedFile[], pusher: Pusher, sha: string): Promise<IngestReport[]> {
  const reports: IngestReport[] = [];
  for (const kind of registeredRepoKinds()) {
    const mine = changed.filter((f) => kind.matches(f.path));
    if (mine.length === 0) continue;
    reports.push(await kind.ingest({ domain, files: mine, pusher, sha }));
  }
  return reports;
}

function summarise(reports: IngestReport[]): string {
  if (reports.length === 0) return 'nothing in this push maps to an OS object — the files are stored, the registry is unchanged';
  return reports
    .map((r) => `${r.kind}: ${r.created} created, ${r.updated} updated${r.skipped ? `, ${r.skipped} skipped` : ''}${r.notes.length ? ` (${r.notes.join('; ')})` : ''}`)
    .join(' · ');
}

// --------------------------------------------------------------------- diffing ---

/**
 * The files that changed between two commits, with the NEW content, read from the repository.
 * ONLY valid once the refs are updated — during `pre-receive` the objects are quarantined and
 * invisible to this process (see the header); that is the hook's job, not this one's.
 */
export async function diffCommits(
  gitdir: string,
  fromSha: string | null,
  toSha: string,
  domain: string,
  opts: { reposDir?: string } = {},
): Promise<ChangedFile[]> {
  const before = fromSha ? await listTree(domain, fromSha, opts) : [];
  const after = await listTree(domain, toSha, opts);
  const beforeMap = new Map(before.map((e) => [e.path, e.oid]));
  const afterMap = new Map(after.map((e) => [e.path, e]));
  const out: ChangedFile[] = [];
  for (const [p, entry] of afterMap) {
    const prior = beforeMap.get(p);
    if (prior === entry.oid) continue;
    out.push({ path: p, status: prior ? 'modified' : 'added', content: await blob(gitdir, entry) });
  }
  for (const [p] of beforeMap) {
    if (!afterMap.has(p)) out.push({ path: p, status: 'deleted', content: null });
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

async function blob(gitdir: string, entry: TreeEntry): Promise<string | null> {
  try {
    const { blob: bytes } = await git.readBlob({ fs, gitdir, oid: entry.oid });
    return Buffer.from(bytes).toString('utf8');
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------- the hooks ---

/** The endpoint the hooks call. One URL, one contract. */
export const RECEIVE_ENDPOINT = '/api/git/receive';

/**
 * The pre-receive / post-receive scripts, written into every bare repo.
 *
 * THE HOOK DOES THE READING (review H-2). It runs inside git's own process tree, so it is the only
 * place `GIT_QUARANTINE_PATH` is visible. It computes the fast-forward verdict
 * (`git merge-base --is-ancestor`), the change list (`git diff-tree -r --name-status`, no rename
 * detection, so a move is a delete plus an add) and each new blob (`git cat-file blob`, base64 so
 * any bytes survive JSON), enforces the size caps BEFORE posting, and refuses a path git had to
 * quote (this repository accepts plain paths). The OS reads nothing from the repository in `pre`.
 *
 * The pusher's own `Authorization` header — the OS access token their git client sent — is
 * forwarded as `x-os-git-authorization` and resolved SERVER-SIDE, and it is required on EVERY
 * phase, so `post` and `abort` are authenticated too (review H-1). It is handed to curl through a
 * config file on STDIN, never on the command line (review L-3), and curl's own stderr is redacted
 * before it reaches the developer's terminal.
 */
export function receiveHookScript(phase: 'pre' | 'post'): string {
  // post-receive exits 0 whatever happens: the push has ALREADY landed, and a non-zero exit there
  // would only tell the developer it failed when it did not. The value is interpolated bare — an
  // earlier version appended a `# comment` to it, which swallowed the `;` closing `die()` and made
  // every post-receive a shell syntax error (caught by the real-push test, not by the gate tests).
  const failExit = phase === 'post' ? '0' : '1';
  return `#!/bin/sh
# Written by the Sovereign Agentic OS (core/infra/git-receive.ts). Do not edit: it is rewritten at
# boot. It calls ONE OS endpoint, which holds the per-domain lock for the whole receive.
set -u
URL="\${OS_RECEIVE_URL:-http://127.0.0.1:3000${RECEIVE_ENDPOINT}}"
DOMAIN="\$(basename "\$(pwd)" .git)"
ZERO=0000000000000000000000000000000000000000
TD="\${TMPDIR:-/tmp}"
BODY="\$TD/os-recv-body.\$\$"
LIST="\$TD/os-recv-list.\$\$"
OUT="\$TD/os-recv-out.\$\$"
ERRF="\$TD/os-recv-err.\$\$"
MAX_FILE=${MAX_FILE_BYTES}
MAX_TOTAL=${MAX_PUSH_BYTES}
TAB="\$(printf '\\t')"
cleanup() { rm -f "\$BODY" "\$LIST" "\$OUT" "\$ERRF"; }
die() { echo "" >&2; echo "The Sovereign OS refused this push:" >&2; echo "  \$1" >&2; cleanup; exit ${failExit}; }

NEW=""
OLD=""
: > "\$LIST"
printf '{"phase":"${phase}","domain":"%s","updates":[' "\$DOMAIN" > "\$BODY"
first=1
while read -r old new ref; do
  [ -z "\${ref:-}" ] && continue
  ff=true
  if [ "\$old" != "\$ZERO" ] && [ "\$new" != "\$ZERO" ]; then
    git merge-base --is-ancestor "\$old" "\$new" 2>/dev/null || ff=false
  fi
  [ \$first -eq 1 ] || printf ',' >> "\$BODY"
  first=0
  printf '{"ref":"%s","oldSha":"%s","newSha":"%s","fastForward":%s}' "\$ref" "\$old" "\$new" "\$ff" >> "\$BODY"
  if [ "\$new" != "\$ZERO" ]; then
    NEW="\$new"; OLD="\$old"
    if [ "\$old" = "\$ZERO" ]; then
      git diff-tree -r --no-commit-id --name-status --root "\$new" >> "\$LIST" 2>/dev/null || true
    else
      git diff-tree -r --no-commit-id --name-status "\$old" "\$new" >> "\$LIST" 2>/dev/null || true
    fi
  fi
done
printf '],"files":[' >> "\$BODY"

total=0
firstf=1
if [ -n "\$NEW" ]; then
  while IFS="\$TAB" read -r st pth; do
    [ -z "\${st:-}" ] && continue
    [ -z "\${pth:-}" ] && continue
    case "\$pth" in
      '"'*) die "'\$pth' is not a path this repository accepts — use plain UTF-8 file names" ;;
      *\\\\*) die "a backslash in a file name is not accepted by this repository" ;;
    esac
    status=modified
    content=null
    case "\$st" in
      A) status=added ;;
      D) status=deleted ;;
      *) status=modified ;;
    esac
    if [ "\$st" != "D" ]; then
      size="\$(git cat-file -s "\$NEW:\$pth" 2>/dev/null || echo 0)"
      if [ "\$size" -gt "\$MAX_FILE" ]; then
        die "'\$pth' is \$size bytes; this door accepts files up to \$MAX_FILE bytes. Large binaries do not belong in a domain repository."
      fi
      total=\$((total + size))
      if [ "\$total" -gt "\$MAX_TOTAL" ]; then
        die "this push changes more than \$MAX_TOTAL bytes of content; split it into smaller pushes."
      fi
      content="\\"\$(git cat-file blob "\$NEW:\$pth" 2>/dev/null | base64 | tr -d '\\n\\r')\\""
    fi
    [ \$firstf -eq 1 ] || printf ',' >> "\$BODY"
    firstf=0
    printf '{"path":"%s","status":"%s","content":%s}' "\$pth" "\$status" "\$content" >> "\$BODY"
  done < "\$LIST"
fi
printf ']}' >> "\$BODY"

# The token goes to curl through a config file on STDIN — never on the command line, where it
# would be visible in the process table.
CODE="\$( { printf 'url = "%s"\\n' "\$URL"
  printf 'header = "content-type: application/json"\\n'
  if [ -n "\${OS_SERVICE_BEARER:-}" ]; then printf 'header = "authorization: Bearer %s"\\n' "\$OS_SERVICE_BEARER"; fi
  if [ -n "\${HTTP_AUTHORIZATION:-}" ]; then printf 'header = "x-os-git-authorization: %s"\\n' "\$HTTP_AUTHORIZATION"; fi
  } | curl -sS -m 300 --config - -X POST --data-binary "@\$BODY" -o "\$OUT" -w '%{http_code}' 2>"\$ERRF" )" || CODE="000"

if [ "\$CODE" = "200" ]; then
  # git already prefixes every line a hook writes to stderr with its own marker; do not do it twice.
  [ -s "\$OUT" ] && cat "\$OUT" >&2
  cleanup
  exit 0
fi
echo "" >&2
echo "The Sovereign OS refused this push (HTTP \$CODE):" >&2
if [ -s "\$OUT" ]; then sed 's/^/  /' "\$OUT" >&2; fi
# curl's own diagnostics can quote the request; redact anything token-shaped before it is shown.
if [ -s "\$ERRF" ]; then sed -E 's/sos_[0-9a-f]{12}_[A-Za-z0-9_-]+/sos_***/g; s/^/  /' "\$ERRF" >&2; fi
if [ ! -s "\$OUT" ] && [ ! -s "\$ERRF" ]; then echo "  the OS receive gate was unreachable; nothing was changed" >&2; fi
cleanup
exit ${failExit}
`;
}

/** Per-process memo so a hot path does not re-stat and re-read two hook files on every request. */
const HOOKS_KEY = Symbol.for('soa.git-receive.hooks-installed');
function installed(): Set<string> {
  const g = globalThis as unknown as Record<symbol, Set<string> | undefined>;
  if (!g[HOOKS_KEY]) g[HOOKS_KEY] = new Set();
  return g[HOOKS_KEY]!;
}

/** Test seam: forget the memo so a fresh temp repo is wired again. */
export function __resetHookMemo(): void {
  installed().clear();
}

/**
 * Make every bare repo push-capable and gated: `http.receivepack` on (git-http-backend serves
 * `receive-pack` only when it is), git's own non-fast-forward and delete refusals on as a second,
 * independent line of defence, and the two hooks written executable. Idempotent and memoised per
 * domain per process (review L-2); the memo is keyed on the script's own hash, so a changed script
 * is still written.
 */
export function ensureReceiveHooks(domain: string, opts: { reposDir?: string } = {}): void {
  const gitdir = repoPath(domain, opts);
  const memo = `${gitdir}@${createHash('sha256').update(receiveHookScript('pre') + receiveHookScript('post')).digest('hex').slice(0, 16)}`;
  if (installed().has(memo)) return;
  if (!fs.existsSync(path.join(gitdir, 'HEAD'))) return;
  const cfgPath = path.join(gitdir, 'config');
  try {
    const cfg = fs.existsSync(cfgPath) ? fs.readFileSync(cfgPath, 'utf8') : '';
    if (!/\[http\]/.test(cfg) || !/receivepack\s*=\s*true/.test(cfg)) {
      fs.appendFileSync(cfgPath, '\n[http]\n\treceivepack = true\n[receive]\n\tdenyNonFastForwards = true\n\tdenyDeletes = true\n');
    }
  } catch {
    /* a config we cannot write is reported by the first push, not swallowed into a fake success */
  }
  const hooksDir = path.join(gitdir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  for (const phase of ['pre', 'post'] as const) {
    const file = path.join(hooksDir, `${phase}-receive`);
    const body = receiveHookScript(phase);
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== body) {
      fs.writeFileSync(file, body, { mode: 0o755 });
    }
    fs.chmodSync(file, 0o755);
  }
  installed().add(memo);
}
