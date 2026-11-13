/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The receive gate — ONE OS endpoint that every `git push` into a domain repo passes
 * USER STORY: As a data or AI engineer I want to push to my domain's repository from VS Code and
 *             have the OS accept it exactly when the UI would have accepted the same change, with
 *             a readable reason on my terminal when it does not — and as the owner I want a push
 *             and an OS write never to interleave (E-US1, E-US3, decisions D27/D28/D29).
 * ARCHITECTURE:
 *   - THE LOCK. `commitTree` serialises OS writers on a per-repo in-process mutex keyed by the
 *     repository path, registered under `Symbol.for('soa.git-store.locks')`. This module chains on
 *     that SAME map with the SAME key, so an OS commit and a `receive-pack` are mutually exclusive
 *     without a second lock to keep in step. The wait is BOUNDED (`lockTimeoutMs`): on timeout the
 *     push fails with a sentence a developer can act on instead of hanging their terminal.
 *     Cross-stream note: `git-store.ts` belongs to streams S and G tonight, so the lock is joined
 *     through the published global symbol rather than by exporting `withLock` (deviation E-1).
 *   - TWO PHASES, ONE LEASE. `pre-receive` takes the lock and holds it in a lease; `post-receive`
 *     ingests and releases it. "For the duration of receive-pack" is what makes the ref update
 *     atomic with respect to the OS's read-head → build-tree → write-commit window. A lease that
 *     is never completed (a killed client) expires on its own (`leaseTtlMs`).
 *   - PATH OWNERSHIP. `decidePaths` is pure: own personal lane always; domain paths by role;
 *     `os/**`, anything grant-shaped and anything secret-shaped NEVER — those files are committed
 *     for transparency, not for editing, and the rejection says so in the owner's words.
 *   - ONE VALIDATOR, NOT A SECOND COPY. `core/` may not import a tab (check-structure rule 3), so
 *     each kind REGISTERS the validator the UI and the MCP already call (`parseSystem`, the dbt
 *     schema reader) through `registerRepoKind`. There is no validator in this file — only the
 *     dispatch — which is the structural reason the two doors cannot drift.
 *   - NO HISTORY REWRITES. A non-fast-forward or a deletion of `main` is refused before anything
 *     else is read.
 *   - NOTHING LOGS A TOKEN. Every message out of this module goes through `redact`.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as git from 'isomorphic-git';
import { config } from '@core/kernel/config';
import { MAIN, listTree, repoExists, repoPath, type TreeEntry } from '@core/infra/git-store';
import { redact } from '@core/auth/access-tokens';

/** The managed-by-the-OS rejection, in the owner's words. Asserted verbatim by the tests. */
export const MANAGED_BY_OS = 'managed by the OS; change it in Governance or over the MCP';

/** Prefixes the OS owns inside every domain repo. Committed for transparency, never pushable. */
export const OS_OWNED_PREFIXES = ['os/'] as const;

/** Default bounded wait for the per-domain lock before a push is failed rather than hung. */
export const DEFAULT_LOCK_TIMEOUT_MS = 20_000;

/** How long an un-completed lease may hold the lock before it is released on its own. */
export const DEFAULT_LEASE_TTL_MS = 180_000;

export type RefUpdate = { ref: string; oldSha: string; newSha: string };

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
  /** Apply the pushed files through the kind's GOVERNED service, as the pusher. */
  ingest(input: { domain: string; files: ChangedFile[]; pusher: Pusher; sha: string }): Promise<IngestReport>;
};

export type IngestReport = { kind: string; created: number; updated: number; skipped: number; notes: string[] };

export type GateDecision =
  | { ok: true; leaseId: string; changed: ChangedFile[]; sha: string }
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

// ------------------------------------------------------------------ the lock ---

/**
 * The SAME map `git-store.ts` serialises its writers on. Joining it (rather than keeping a second
 * lock in step) is the only way an OS commit and a `receive-pack` can be mutually exclusive.
 */
const LOCK_KEY = Symbol.for('soa.git-store.locks');
function locks(): Map<string, Promise<unknown>> {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<unknown>> | undefined>;
  if (!g[LOCK_KEY]) g[LOCK_KEY] = new Map();
  return g[LOCK_KEY]!;
}

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
  changed: ChangedFile[];
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

/**
 * Take the per-repo lock and hold it until the returned `release` is called (or the TTL fires).
 * The entry is installed SYNCHRONOUSLY, before the wait, so two concurrent pushes queue instead of
 * both believing they hold it; the bounded wait applies only to the predecessor.
 */
async function acquire(key: string, timeoutMs: number, domain: string): Promise<() => void> {
  const prev = locks().get(key) ?? Promise.resolve();
  let release!: () => void;
  const mine = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks().set(
    key,
    prev.then(
      () => mine,
      () => mine,
    ),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), Math.max(1, timeoutMs));
  });
  const outcome = await Promise.race([prev.then(() => 'ready' as const, () => 'ready' as const), bounded]);
  if (timer) clearTimeout(timer);
  if (outcome === 'timeout') {
    release(); // never block the next waiter on a push we are abandoning
    throw new LockTimeoutError(domain, timeoutMs);
  }
  return release;
}

// ------------------------------------------------------------- path ownership ---

/**
 * `models/personal/<sanitised id>/` — the dbt generator's personal lane. The token is the SAME
 * `sanitizeIdent` shape the Trino personal schema uses (`personal_<uid>`), because the directory is
 * derived from that schema name (`tabs/data/lib/dbt/models.ts`). A core module may not import a tab
 * (check-structure rule 3), so the convention is restated here — and `git-receive.test.ts` asserts
 * it still AGREES with the tab's own helpers, which is what stops the restatement drifting.
 */
export function personalDataLane(userId: string): string {
  const token = String(userId ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'user';
  return `models/personal/${token}/`;
}

/**
 * `agents/personal/<owner token>/` — the Agents generator's personal lane. Its token is an OPAQUE
 * `sha256(<principal id>)` prefix, deliberately NOT a username (the subtree travels to every mirror
 * and clone), mirroring `tabs/agents/lib/git/generate.ts` `ownerToken`.
 */
export function personalAgentLane(userId: string): string {
  return `agents/personal/${createHash('sha256').update(String(userId ?? '')).digest('hex').slice(0, 12)}/`;
}

/** Every prefix this principal may always write, whatever their role. */
export function personalLanes(userId: string): string[] {
  return [personalDataLane(userId), personalAgentLane(userId)];
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

export type PathVerdict = { allowed: true } | { allowed: false; reason: string };

/**
 * May this pusher change this path? PURE — this is the function the unit tests enumerate.
 *   - `os/**`, grant files and anything secret-shaped: NEVER, by anybody, with the managed-by-the-OS
 *     sentence. They are committed so nothing is a black box, not so they can be edited.
 *   - the pusher's own personal lane: always.
 *   - a domain path (the shared dbt layers, a shared agent system): builder and above.
 *   - anything else at the project root (`dbt_project.yml`, `README.md`, macros, generic tests):
 *     builder and above, because it changes the whole domain's project.
 */
export function decidePath(filePath: string, pusher: Pusher): PathVerdict {
  const p = filePath.replace(/^\/+/, '');
  if (p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
    return { allowed: false, reason: `'${filePath}' is not a path this repository accepts` };
  }
  if (OS_OWNED_PREFIXES.some((prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix))) {
    return { allowed: false, reason: `'${p}' is ${MANAGED_BY_OS}` };
  }
  if (/(^|\/)grants?\.(ya?ml|json)$/i.test(p)) {
    return { allowed: false, reason: `'${p}' is a grant file — ${MANAGED_BY_OS}` };
  }
  // `agents/index.yml` is the slug → system-identity map the OS generates. A directory name is not
  // an identity, and an identity map is not something a push may rewrite.
  if (p === 'agents/index.yml') {
    return { allowed: false, reason: `'${p}' is the OS's system-identity map — ${MANAGED_BY_OS}` };
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
  now?: () => number;
};

/**
 * PHASE 1 — `pre-receive`. Takes the lock, refuses a rewrite, computes the changed files, decides
 * ownership, runs every registered kind's validator, and holds the lock in a lease until
 * `completeReceive` (or the TTL). A rejection releases the lock immediately.
 */
export async function beginReceive(
  input: { domain: string; pusher: Pusher; updates: RefUpdate[] },
  deps: GateDeps = {},
): Promise<GateDecision> {
  const { domain, pusher, updates } = input;
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

  const gitdir = repoPath(domain, { reposDir });
  let release: (() => void) | null = null;
  try {
    release = await acquire(gitdir, deps.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS, domain);
  } catch (e) {
    if (e instanceof LockTimeoutError) return { ok: false, status: e.status, message: redact(e.message) };
    throw e;
  }

  try {
    const update = refs[0];
    const ZERO = '0'.repeat(40);
    if (update.newSha === ZERO) {
      return reject(release, 400, 'main cannot be deleted — the OS never rewrites, and never accepts a rewrite of, history');
    }
    // NO HISTORY REWRITES: the old head must still be an ancestor of the new one.
    if (update.oldSha && update.oldSha !== ZERO) {
      let fastForward = false;
      try {
        fastForward = await git.isDescendent({ fs, gitdir, oid: update.newSha, ancestor: update.oldSha, depth: -1 });
      } catch {
        fastForward = false;
      }
      if (!fastForward) {
        return reject(
          release,
          409,
          'this push is not a fast-forward of main — the OS never rewrites, and never accepts a rewrite of, ' +
            'history. Rebase onto the current main and push again.',
        );
      }
    }

    const changed = await diffCommits(gitdir, update.oldSha === ZERO ? null : update.oldSha, update.newSha, domain, { reposDir });

    // 1 — ownership, 2 — secret-shaped, 3 — the kind's own validator. The FIRST failure is the
    // message, because a developer fixes one thing at a time.
    for (const f of changed) {
      const verdict = decidePath(f.path, pusher);
      if (!verdict.allowed) return reject(release, 403, verdict.reason);
      const secret = looksSecretShaped(f.path, f.content);
      if (secret) return reject(release, 403, secret);
    }
    for (const f of changed) {
      if (f.status === 'deleted' || f.content === null) continue;
      for (const kind of registeredRepoKinds()) {
        if (!kind.matches(f.path)) continue;
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
    const lease: Lease = {
      id: leaseId,
      domain,
      release,
      pusher,
      changed,
      sha: update.newSha,
      timer: setTimeout(() => {
        const l = leases().get(domain);
        if (l && l.id === leaseId) {
          leases().delete(domain);
          l.release();
        }
      }, Math.max(1, ttl)),
    };
    // A lease timer must never keep the process alive on its own.
    (lease.timer as unknown as { unref?: () => void }).unref?.();
    leases().set(domain, lease);
    return { ok: true, leaseId, changed, sha: update.newSha };
  } catch (e) {
    release();
    return { ok: false, status: 500, message: redact(e instanceof Error ? e.message : String(e)) };
  }
}

function reject(release: () => void, status: number, message: string): GateDecision {
  release();
  return { ok: false, status, message: redact(message) };
}

/**
 * PHASE 2 — `post-receive`. The refs ARE updated now, so the registry is reconciled from the files
 * and the lock is released. An ingest failure is reported, never hidden: the push has landed, and
 * pretending otherwise would be a fabricated result.
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
  try {
    const reports = await ingestChanged(lease.domain, lease.changed, lease.pusher, lease.sha);
    return { ok: true, reports, message: summarise(reports) };
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
 * The files that changed between two commits, with the NEW content. Implemented over the same
 * `listTree` the read path uses: a domain project is a few hundred small files, and reusing one
 * reader keeps the gate and the UI looking at identical bytes.
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
 * The pre-receive / post-receive scripts, written into every bare repo. POSIX sh + curl (both in
 * the `git-http` sidecar image); the response BODY is the message the developer sees and the HTTP
 * STATUS is the verdict, so the hook parses no JSON.
 *
 * The pusher's own `Authorization` header — the OS personal access token their git client sent —
 * is forwarded as `x-os-git-authorization` and resolved SERVER-SIDE. The gate therefore
 * authenticates the push itself and does not depend on the ingress having done it.
 */
export function receiveHookScript(phase: 'pre' | 'post'): string {
  const failOpen = phase === 'post';
  return `#!/bin/sh
# Written by the Sovereign Agentic OS (core/infra/git-receive.ts). Do not edit: it is rewritten
# at boot. It calls ONE OS endpoint, which holds the per-domain lock for the whole receive.
set -u
URL="\${OS_RECEIVE_URL:-http://127.0.0.1:3000${RECEIVE_ENDPOINT}}"
DOMAIN="\$(basename "\$(pwd)" .git)"
OUT="\$(mktemp 2>/dev/null || echo /tmp/os-receive.\$\$)"
UPDATES=""
while read -r old new ref; do
  [ -z "\$ref" ] && continue
  [ -n "\$UPDATES" ] && UPDATES="\$UPDATES,"
  UPDATES="\$UPDATES{\\"ref\\":\\"\$ref\\",\\"oldSha\\":\\"\$old\\",\\"newSha\\":\\"\$new\\"}"
done
BODY="{\\"phase\\":\\"${phase}\\",\\"domain\\":\\"\$DOMAIN\\",\\"updates\\":[\$UPDATES]}"
CODE="\$(curl -sS -m 300 -o "\$OUT" -w '%{http_code}' \\
  -X POST "\$URL" \\
  -H 'content-type: application/json' \\
  \${OS_SERVICE_BEARER:+-H "authorization: Bearer \$OS_SERVICE_BEARER"} \\
  \${HTTP_AUTHORIZATION:+-H "x-os-git-authorization: \$HTTP_AUTHORIZATION"} \\
  --data-binary "\$BODY" 2>>"\$OUT")" || CODE="000"
if [ "\$CODE" = "200" ]; then
  [ -s "\$OUT" ] && sed 's/^/remote: /' "\$OUT" >&2
  rm -f "\$OUT"
  exit 0
fi
echo "" >&2
echo "The Sovereign OS refused this push (HTTP \$CODE):" >&2
if [ -s "\$OUT" ]; then sed 's/^/  /' "\$OUT" >&2; else echo "  the OS receive gate was unreachable; nothing was changed" >&2; fi
rm -f "\$OUT"
${failOpen ? 'exit 0   # post-receive: the push has ALREADY landed; failing here would only hide it' : 'exit 1'}
`;
}

/**
 * Make every bare repo push-capable and gated: `http.receivepack` on (git-http-backend serves
 * `receive-pack` only when it is), git's own non-fast-forward and delete refusals on as a second
 * line of defence, and the two hooks written executable. Idempotent, cheap, and safe to call on
 * every boot and before every authenticated request.
 */
export function ensureReceiveHooks(domain: string, opts: { reposDir?: string } = {}): void {
  const gitdir = repoPath(domain, opts);
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
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === body) continue;
    fs.writeFileSync(file, body, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
}
