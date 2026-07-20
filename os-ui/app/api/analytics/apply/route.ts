/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireAdmin, type CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { config } from '@/lib/core/config';
import { getPublicUser } from '@/lib/platform-admin/users';
import { listGovernedDatasets, getDataset, type Principal } from '@/lib/data/store';
import {
  planApply,
  type ApplyPlan,
  type ChangedFile,
  type FileDecision,
} from '@/lib/data/analytics-apply';

export const dynamic = 'force-dynamic';

/**
 * #146 Phase 1 — the registry-APPLY enforcement point (plan §3 step 6).
 * THE ONLY door from git into compute.
 *
 * AUTH (mirrors catalog-refresh-cronjob.yaml EXACTLY): the route is admin-gated
 * (`requireAdmin`). A UI call arrives with the signed-in admin's session; a CI
 * call arrives with an admin SERVICE-PRINCIPAL session (the CronJob/Actions job
 * logs in via /api/auth/login as the service principal, captures the cookie, then
 * POSTs here). Both are the SAME governed session — the app enforces admin, we
 * never bake a bypass. GATED additionally behind `analyticsApplyEnabled` (default
 * OFF): nothing applies until an operator turns it on.
 *
 * FLOW:
 *   1. Read the diff at {sha} from Forgejo (changed OS-managed files + their bytes
 *      at that ref) — reusing the SAME `config.forgejo*` credentials the mirror uses.
 *   2. Map changed OS-managed files → datasets + ROUND-TRIP verify against the
 *      current registry via the shared emitters (pure `planApply`). A file the
 *      emitters can't reproduce is REJECTED (single-writer invariant).
 *   3. Re-run OPA/tier/promotion checks AS THE MAPPED PRINCIPAL (the commit author
 *      when resolvable to an OS user; the OS approver — the calling admin — as
 *      fallback). A DENY surfaces honestly.
 *   4. The registry update: in Phase 1 the registry is authoritative, so a file
 *      that round-trips ALREADY matches the registry — the "update" is a verified
 *      no-op convergence. Nothing is silently changed; the governed builder /
 *      promotion path remains the only registry writer.
 *
 *   GET  ?sha=…  → PREVIEW (dry-run, ZERO writes, no governed side effects beyond
 *                  read-scoped authz probes).
 *   POST ?sha=…  (or JSON { sha }) → APPLY.
 *
 * HONESTY: a policy DENY or a non-round-trippable file returns a clear failure the
 * CI writes back to the PR as a failed status — never a silent drop, never a fake
 * success. The end-to-end apply is LIVE-VERIFY-PENDING (needs Forgejo +
 * analyticsRepo.enabled + Forgejo Actions running).
 */

const ANALYTICS_REPO = 'analytics';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

function shaFrom(req: Request, body?: { sha?: unknown }): string | null {
  const q = new URL(req.url).searchParams.get('sha');
  const raw = (typeof body?.sha === 'string' ? body.sha : q) ?? '';
  const sha = raw.trim();
  return /^[0-9a-fA-F]{7,64}$/.test(sha) ? sha : null;
}

// ─── Forgejo diff read (route-level I/O; same creds as the mirror client) ──────

function forgejoAuth(): string {
  return 'Basic ' + Buffer.from(`${config.forgejoUser}:${config.forgejoPassword}`).toString('base64');
}
function encodePath(p: string): string {
  return p.split('/').map(encodeURIComponent).join('/');
}
async function forgejoApi(path: string): Promise<Response | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    return await fetch(`${config.forgejoUrl}/api/v1${path}`, {
      headers: { authorization: forgejoAuth(), accept: 'application/json' },
      cache: 'no-store',
      signal: ctrl.signal,
    });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** A single file's decoded content AT a git ref, or null (absent/unreachable). */
async function readAtRef(repo: string, path: string, ref: string): Promise<string | null> {
  const owner = config.forgejoRepoOwner;
  const res = await forgejoApi(`/repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(ref)}`);
  if (!res || !res.ok) return null;
  const d = (await res.json().catch(() => null)) as { content?: string; encoding?: string } | null;
  if (!d || typeof d.content !== 'string') return null;
  return d.encoding === 'base64' ? Buffer.from(d.content, 'base64').toString('utf8') : d.content;
}

/** The commit's metadata (author login) + changed file paths at {sha}. */
type CommitInfo = { authorLogin: string | null; changedPaths: string[] };

/**
 * Read a commit's changed files + author from Forgejo's commit API. Returns null
 * when the commit can't be read (unreachable / not found) so the route fails
 * loudly rather than pretending an empty diff.
 */
async function readCommit(repo: string, sha: string): Promise<CommitInfo | null> {
  const owner = config.forgejoRepoOwner;
  const res = await forgejoApi(`/repos/${owner}/${repo}/git/commits/${encodeURIComponent(sha)}`);
  if (!res || !res.ok) return null;
  const d = (await res.json().catch(() => null)) as {
    files?: { filename?: string }[];
    author?: { login?: string } | null;
  } | null;
  if (!d || !Array.isArray(d.files)) return null;
  const changedPaths = d.files.map((f) => String(f?.filename ?? '')).filter(Boolean);
  const authorLogin = d.author?.login ? String(d.author.login) : null;
  return { authorLogin, changedPaths };
}

/** Read the changed OS-managed files' bytes AT {sha}. Non-OS-managed paths are
 *  passed through too (so the pure core can flag them ignored) but not fetched —
 *  we only need contents for OS-managed paths, since those are what we verify. */
async function readChangedFiles(repo: string, sha: string, paths: string[]): Promise<ChangedFile[]> {
  const out: ChangedFile[] = [];
  for (const path of paths) {
    // Only OS-managed paths need content for round-trip verification; a deleted
    // file reads as null at the ref and is skipped (a delete of a governed mirror
    // file is a divergence the next mirror pass re-writes — not this route's write).
    const content = await readAtRef(repo, path, sha);
    if (content !== null) out.push({ path, content });
  }
  return out;
}

// ─── Governed re-check AS the mapped principal ─────────────────────────────────

/**
 * Resolve the acting principal for the apply: the COMMIT AUTHOR when it maps to a
 * real OS user, else the OS APPROVER (the calling admin) as fallback — exactly the
 * plan §6 rule ("commit author when per-user; the PR's OS approver otherwise").
 */
async function resolvePrincipal(authorLogin: string | null, approver: CurrentUser): Promise<Principal> {
  if (authorLogin) {
    const u = await getPublicUser(authorLogin);
    if (u) return { id: u.id, domains: u.domains, role: u.role };
  }
  return { id: approver.id, domains: approver.domains, role: approver.role };
}

/**
 * Re-run the governed check for ONE accepted, dataset-scoped decision AS the mapped
 * principal — the SAME gates the UI/MCP op runs. `getDataset` enforces DLS/OPA view
 * scope (403 if the principal can't see it); a semantic-layer (cube/schema) change
 * additionally needs owner-or-builder+ (mirroring the store's `metricScopeOf`).
 * Returns a REJECTING FileDecision on deny (honest), or null when the principal is
 * authorized. Never mutates the registry.
 */
function governedRecheck(decision: FileDecision, principal: Principal): FileDecision | null {
  if (!decision.datasetId) return null; // exposures / non-dataset — no per-dataset op
  let dataset;
  try {
    dataset = getDataset(decision.datasetId, principal); // throws 403 on DLS/OPA deny
  } catch (e) {
    return {
      ...decision,
      ok: false,
      reason: `policy DENY for principal '${principal.id}' on dataset '${decision.datasetId}': ${(e as Error).message}`,
    };
  }
  // Semantic-layer changes (cube model / schema docs == measures) need Builder+ or ownership.
  if ((decision.kind === 'cube' || decision.kind === 'dbt-schema')
      && dataset.owner !== principal.id
      && !roleAtLeast(principal.role, 'builder')) {
    return {
      ...decision,
      ok: false,
      reason: `policy DENY: principal '${principal.id}' (role ${principal.role}) may not change the semantic layer of dataset '${decision.datasetId}' — Builder+ or ownership required`,
    };
  }
  return null; // authorized
}

/**
 * Fold the governed re-checks over an already-round-tripped plan. Any DENY turns
 * that decision into a rejection and flips the roll-up. Files that failed the
 * round-trip stay rejected; ignored/exposures decisions pass through.
 */
function applyGovernedChecks(plan: ApplyPlan, principal: Principal): ApplyPlan {
  const decisions = plan.decisions.map((d) => {
    if (!d.ok || d.ignored) return d; // already rejected, or human-space
    const denied = governedRecheck(d, principal);
    return denied ?? d;
  });
  return { ok: decisions.every((d) => d.ok), decisions };
}

// ─── the run (shared by preview + apply) ───────────────────────────────────────

type RunResult =
  | { status: number; body: Record<string, unknown> };

async function run(sha: string, approver: CurrentUser, mode: 'preview' | 'apply'): Promise<RunResult> {
  // 1. Read the commit (author + changed paths) at {sha}. Unreachable ⇒ honest 503.
  const commit = await readCommit(ANALYTICS_REPO, sha);
  if (!commit) {
    return { status: 503, body: { ok: false, sha, error: 'Forgejo unreachable or commit not found', mode } };
  }
  const files = await readChangedFiles(ANALYTICS_REPO, sha, commit.changedPaths);

  // 2. Map + round-trip verify against the CURRENT registry (pure).
  const datasets = listGovernedDatasets();
  const roundTrip = planApply(files, datasets);

  // 3. Re-run OPA/tier/promotion AS the mapped principal (author → OS user, else approver).
  const principal = await resolvePrincipal(commit.authorLogin, approver);
  const plan = applyGovernedChecks(roundTrip, principal);

  const osManaged = plan.decisions.filter((d) => !d.ignored);
  const rejected = osManaged.filter((d) => !d.ok);

  // 4. The registry update. Phase 1: the registry is authoritative, so an accepted
  //    (round-tripped + authorized) OS-managed file ALREADY matches the registry —
  //    convergence is a verified no-op. We NEVER write on a rejection. On `apply`
  //    with everything accepted, the registry is confirmed convergent; the mirror
  //    would re-emit byte-identical (zero commits).
  const body: Record<string, unknown> = {
    ok: plan.ok,
    mode,
    sha,
    actingPrincipal: principal.id,
    authorMapped: commit.authorLogin !== null && principal.id !== approver.id,
    osManagedFiles: osManaged.length,
    ignoredFiles: plan.decisions.length - osManaged.length,
    accepted: osManaged.filter((d) => d.ok).map((d) => ({ path: d.path, kind: d.kind, datasetId: d.datasetId })),
    rejected: rejected.map((d) => ({ path: d.path, kind: d.kind, datasetId: d.datasetId, reason: d.reason })),
    registryUpdated: false,
    note:
      'Phase 1: the registry is authoritative for compute; an accepted OS-managed file already matches the registry (verified round-trip convergence). End-to-end apply is live-verify-pending (needs Forgejo + analyticsRepo.enabled + Actions).',
  };

  if (!plan.ok) {
    // A merged PR that fails policy/round-trip here does NOT reach compute; the CI
    // writes this reason back to the PR as a failed status. 422 = the change is
    // invalid (honest, visible), not a server error.
    return { status: 422, body };
  }
  return { status: 200, body };
}

// ─── HTTP ──────────────────────────────────────────────────────────────────────

export async function GET(req: Request) {
  try {
    const admin = await requireAdmin();
    if (!config.analyticsApplyEnabled) {
      return NextResponse.json(
        { error: 'Analytics apply is disabled (ANALYTICS_APPLY_ENABLED is not true).' },
        { status: 403 },
      );
    }
    const sha = shaFrom(req);
    if (!sha) return NextResponse.json({ error: 'A valid ?sha= (7–64 hex chars) is required.' }, { status: 400 });
    const { status, body } = await run(sha, admin, 'preview');
    return NextResponse.json(body, { status });
  } catch (e) {
    return fail(e);
  }
}

export async function POST(req: Request) {
  try {
    const admin = await requireAdmin();
    if (!config.analyticsApplyEnabled) {
      return NextResponse.json(
        { error: 'Analytics apply is disabled (ANALYTICS_APPLY_ENABLED is not true).' },
        { status: 403 },
      );
    }
    const bodyJson = (await req.json().catch(() => ({}))) as { sha?: unknown };
    const sha = shaFrom(req, bodyJson);
    if (!sha) return NextResponse.json({ error: 'A valid sha (7–64 hex chars) is required.' }, { status: 400 });
    const { status, body } = await run(sha, admin, 'apply');
    return NextResponse.json(body, { status });
  } catch (e) {
    return fail(e);
  }
}
