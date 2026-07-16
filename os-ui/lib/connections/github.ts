/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import type { Connection } from '@/lib/connections/schema';
import { getSecretServerSide } from '@/lib/infra/secrets';
import { getConnectionForUser } from '@/lib/connections/store';

/**
 * GitHub REST + GraphQL client — the per-connection bridge to a customer's GitHub.
 *
 * A governed OUTBOUND connection: OS agents read repos/issues/PRs and (approval-gated)
 * open issues/comments/PRs through the SAME capability gate every other connection
 * tool passes. This module is the PURE, testable client (`fetch` injected, the PAT
 * injected as an ARG, never logged/returned) plus a thin SERVER-SIDE bridge that
 * resolves the connection under the caller's identity (DLS) and dereferences the
 * vaulted token HERE (never leaves the server).
 *
 * Same discipline as `airflow.ts`: every call NEVER throws to the caller — it
 * degrades to `{ ok:false, reason }` so honest errors surface without crashing.
 *
 * QUIRKS handled (per CONNECTOR-STANDARD §5):
 *  • Secondary rate limits — a 403/429 with `Retry-After` (or `x-ratelimit-remaining:0`)
 *    is surfaced as an honest `rate-limited` reason with the retry hint; the client
 *    itself does NOT hammer (a single capped-backoff retry with jitter on 429).
 *  • Pagination — Link-header `rel="next"` is followed up to a bounded page count,
 *    with a `truncated` flag when more remains (never an unbounded dump).
 *  • `owner/repo` is validated before it is ever folded into a path.
 *  • No idempotency key exists in the GitHub API for create_issue / create_pull_request,
 *    so writes DEDUPE on (title+body) against recent open items — a retry can't
 *    double-open (§5 idempotency, honestly degraded to a dedupe guard).
 */

/** Injectable fetch — the global `fetch` in prod, a fake in tests. */
export type GithubFetch = typeof fetch;

export const GITHUB_API = 'https://api.github.com';
/** Max pages to follow on a Link-paginated read before flagging `truncated`. */
export const GITHUB_MAX_PAGES = 5;
/** Per-page size requested from the API. */
export const GITHUB_PER_PAGE = 50;

/** A per-connection GitHub client config: where + the token. */
export type GithubConn = {
  /** API base (default api.github.com; GHE would override). */
  baseUrl: string;
  /** The PAT (resolved from the vault). Absent ⇒ calls honestly fail auth. */
  token?: string;
  fetchImpl: GithubFetch;
  timeoutMs?: number;
};

/** A GitHub read/write that never throws: either data, or an honest failure reason. */
export type GithubResult<T> =
  | { ok: true; data: T; truncated?: boolean }
  | { ok: false; reason: string };

/**
 * Build the auth headers. The token is used ONLY to construct the Authorization
 * header; it is never returned or logged. Absent token ⇒ no Authorization header
 * (the call honestly fails auth rather than sending a broken header).
 */
export function githubAuthHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'sovereign-agentic-os',
  };
  if (token) h.authorization = `Bearer ${token}`;
  return h;
}

/** Validate an `owner/repo` slug BEFORE folding it into a path (never trust input). */
export function isValidRepoSlug(slug: string): boolean {
  return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(slug);
}

function base(conn: GithubConn): string {
  return (conn.baseUrl || GITHUB_API).replace(/\/$/, '');
}

/** Honest reason for a rate-limited response (never hammer; surface the hint). */
function rateReason(res: Response): string | null {
  const remaining = res.headers.get('x-ratelimit-remaining');
  const retryAfter = res.headers.get('retry-after');
  if (res.status === 429 || (res.status === 403 && (remaining === '0' || retryAfter))) {
    return `rate-limited; retry after ${retryAfter ?? '60'}s`;
  }
  return null;
}

async function withTimeout(
  conn: GithubConn,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), conn.timeoutMs ?? 6000);
  try {
    return await conn.fetchImpl(url, { ...init, signal: ctrl.signal, cache: 'no-store' });
  } finally {
    clearTimeout(timer);
  }
}

/** Parse the `Link` header's `rel="next"` URL, or null when there is no next page. */
export function nextLink(linkHeader: string | null): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(',')) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/**
 * GET one REST resource as JSON. Never throws — a non-OK status or a network error
 * becomes an honest reason. Surfaces rate-limit hints explicitly.
 */
async function ghGet(conn: GithubConn, path: string): Promise<GithubResult<unknown>> {
  const url = path.startsWith('http') ? path : `${base(conn)}${path}`;
  try {
    const res = await withTimeout(conn, url, { method: 'GET', headers: githubAuthHeaders(conn.token) });
    const rl = rateReason(res);
    if (rl) return { ok: false, reason: rl };
    if (res.status === 404) return { ok: false, reason: 'not_found' };
    if (!res.ok) return { ok: false, reason: `GitHub ${res.status}` };
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, reason: 'unreachable' };
  }
}

/**
 * GET a Link-paginated collection, following `rel="next"` up to `GITHUB_MAX_PAGES`.
 * Returns the concatenated rows and `truncated:true` when more pages remain. Never
 * throws. Rate-limit / error on any page returns an honest reason for what we have so far.
 */
async function ghGetPaged(conn: GithubConn, path: string): Promise<GithubResult<unknown[]>> {
  const rows: unknown[] = [];
  let url: string | null = path.startsWith('http') ? path : `${base(conn)}${path}`;
  let pages = 0;
  let truncated = false;
  while (url && pages < GITHUB_MAX_PAGES) {
    try {
      const res: Response = await withTimeout(conn, url, { method: 'GET', headers: githubAuthHeaders(conn.token) });
      const rl = rateReason(res);
      if (rl) return { ok: false, reason: rl };
      if (res.status === 404) return { ok: false, reason: 'not_found' };
      if (!res.ok) return { ok: false, reason: `GitHub ${res.status}` };
      const body = await res.json();
      // Search endpoints wrap rows in `{ items: [...] }`; list endpoints return an array.
      const page = Array.isArray(body) ? body : Array.isArray(body?.items) ? body.items : [];
      for (const r of page) rows.push(r);
      url = nextLink(res.headers.get('link'));
      pages += 1;
      if (url && pages >= GITHUB_MAX_PAGES) truncated = true;
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }
  return { ok: true, data: rows, truncated };
}

/**
 * POST/PATCH a JSON body. Never throws. NOTE: the GOVERNANCE gate (Write-approval)
 * is enforced UPSTREAM in `callConnectionTool` — a write helper is only reached once
 * the call is allowed. A single capped backoff-with-jitter retry runs on a 429.
 */
async function ghSend(
  conn: GithubConn,
  method: 'POST' | 'PATCH',
  path: string,
  body: Record<string, unknown>,
): Promise<GithubResult<unknown>> {
  const url = `${base(conn)}${path}`;
  const headers = { ...githubAuthHeaders(conn.token), 'content-type': 'application/json' };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await withTimeout(conn, url, { method, headers, body: JSON.stringify(body) });
      if (res.status === 429 && attempt === 0) {
        // Capped exponential backoff with FULL JITTER (§5) — one retry, never hammer.
        const retryAfter = Number(res.headers.get('retry-after') ?? '1');
        const capped = Math.min(retryAfter, 5);
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * capped * 1000)));
        continue;
      }
      const rl = rateReason(res);
      if (rl) return { ok: false, reason: rl };
      if (res.status === 404) return { ok: false, reason: 'not_found' };
      if (!res.ok) return { ok: false, reason: `GitHub ${res.status}` };
      return { ok: true, data: await res.json().catch(() => ({})) };
    } catch {
      return { ok: false, reason: 'unreachable' };
    }
  }
  return { ok: false, reason: 'rate-limited; retry later' };
}

// --------------------------------------------------------------- liveness -------

/**
 * Liveness probe: GET /user (the authenticated user). ANY 2xx proves the token is
 * live; a 401 means the token is bad (honest ✗, not a fake green); a network error
 * means genuinely unreachable. The token is used ONLY as the bearer — never returned.
 */
export async function githubHealth(
  conn: GithubConn,
): Promise<{ connected: boolean; detail?: string; reason?: string }> {
  try {
    const res = await withTimeout(conn, `${base(conn)}/user`, {
      method: 'GET',
      headers: githubAuthHeaders(conn.token),
    });
    if (res.status === 401) return { connected: false, reason: 'unauthorized (bad or missing token)' };
    const rl = rateReason(res);
    if (rl) return { connected: false, reason: rl };
    if (!res.ok) return { connected: false, reason: `GitHub ${res.status}` };
    const j = (await res.json().catch(() => ({}))) as { login?: string };
    return { connected: true, detail: j.login ? `authenticated as ${j.login}` : undefined };
  } catch {
    return { connected: false, reason: 'unreachable' };
  }
}

// ------------------------------------------------------------- reads (auto) -----

export type GithubRepo = { fullName: string; private: boolean; description: string; defaultBranch: string };
export type GithubIssue = { number: number; title: string; state: string; user: string; url: string };
export type GithubPull = { number: number; title: string; state: string; user: string; url: string; head: string; base: string };
export type GithubCommit = { sha: string; message: string; author: string; date: string };
export type GithubCodeHit = { repo: string; path: string; url: string };

function shapeRepo(d: Record<string, unknown>): GithubRepo {
  return {
    fullName: String(d.full_name ?? ''),
    private: Boolean(d.private),
    description: String(d.description ?? ''),
    defaultBranch: String(d.default_branch ?? ''),
  };
}
function shapeIssue(d: Record<string, unknown>): GithubIssue {
  return {
    number: Number(d.number ?? 0),
    title: String(d.title ?? ''),
    state: String(d.state ?? ''),
    user: String((d.user as { login?: string })?.login ?? ''),
    url: String(d.html_url ?? ''),
  };
}
function shapePull(d: Record<string, unknown>): GithubPull {
  return {
    number: Number(d.number ?? 0),
    title: String(d.title ?? ''),
    state: String(d.state ?? ''),
    user: String((d.user as { login?: string })?.login ?? ''),
    url: String(d.html_url ?? ''),
    head: String((d.head as { ref?: string })?.ref ?? ''),
    base: String((d.base as { ref?: string })?.ref ?? ''),
  };
}

/** GET /user/repos — list repos the authenticated user can see. Read. */
export async function listRepos(conn: GithubConn): Promise<GithubResult<GithubRepo[]>> {
  const r = await ghGetPaged(conn, `/user/repos?per_page=${GITHUB_PER_PAGE}&sort=updated`);
  if (!r.ok) return r;
  return { ok: true, data: (r.data as Record<string, unknown>[]).map(shapeRepo), truncated: r.truncated };
}

/** GET /repos/{owner}/{repo} — read one repo. Read. */
export async function getRepo(conn: GithubConn, repo: string): Promise<GithubResult<GithubRepo>> {
  if (!isValidRepoSlug(repo)) return { ok: false, reason: 'repo must be "owner/repo"' };
  const r = await ghGet(conn, `/repos/${repo}`);
  if (!r.ok) return r;
  return { ok: true, data: shapeRepo(r.data as Record<string, unknown>) };
}

/** GET /repos/{owner}/{repo}/issues — list issues (excludes PRs). Read. */
export async function listIssues(
  conn: GithubConn,
  repo: string,
  opts?: { state?: string },
): Promise<GithubResult<GithubIssue[]>> {
  if (!isValidRepoSlug(repo)) return { ok: false, reason: 'repo must be "owner/repo"' };
  const state = opts?.state && ['open', 'closed', 'all'].includes(opts.state) ? opts.state : 'open';
  const r = await ghGetPaged(conn, `/repos/${repo}/issues?state=${state}&per_page=${GITHUB_PER_PAGE}`);
  if (!r.ok) return r;
  // GitHub returns PRs under /issues too; filter them out (they carry pull_request).
  const rows = (r.data as Record<string, unknown>[]).filter((d) => !d.pull_request).map(shapeIssue);
  return { ok: true, data: rows, truncated: r.truncated };
}

/** GET /repos/{owner}/{repo}/issues/{number} — read one issue. Read. */
export async function getIssue(conn: GithubConn, repo: string, number: number): Promise<GithubResult<GithubIssue>> {
  if (!isValidRepoSlug(repo)) return { ok: false, reason: 'repo must be "owner/repo"' };
  const r = await ghGet(conn, `/repos/${repo}/issues/${encodeURIComponent(String(number))}`);
  if (!r.ok) return r;
  return { ok: true, data: shapeIssue(r.data as Record<string, unknown>) };
}

/** GET /search/code — search code across the token's visible repos. Read (bounded). */
export async function searchCode(conn: GithubConn, query: string): Promise<GithubResult<GithubCodeHit[]>> {
  if (!query.trim()) return { ok: false, reason: 'search_code needs a query' };
  const r = await ghGetPaged(conn, `/search/code?q=${encodeURIComponent(query)}&per_page=${GITHUB_PER_PAGE}`);
  if (!r.ok) return r;
  const rows = (r.data as Record<string, unknown>[]).map((d) => ({
    repo: String((d.repository as { full_name?: string })?.full_name ?? ''),
    path: String(d.path ?? ''),
    url: String(d.html_url ?? ''),
  }));
  return { ok: true, data: rows, truncated: r.truncated };
}

/** GET /repos/{owner}/{repo}/pulls — list pull requests. Read. */
export async function listPulls(
  conn: GithubConn,
  repo: string,
  opts?: { state?: string },
): Promise<GithubResult<GithubPull[]>> {
  if (!isValidRepoSlug(repo)) return { ok: false, reason: 'repo must be "owner/repo"' };
  const state = opts?.state && ['open', 'closed', 'all'].includes(opts.state) ? opts.state : 'open';
  const r = await ghGetPaged(conn, `/repos/${repo}/pulls?state=${state}&per_page=${GITHUB_PER_PAGE}`);
  if (!r.ok) return r;
  return { ok: true, data: (r.data as Record<string, unknown>[]).map(shapePull), truncated: r.truncated };
}

/** GET /repos/{owner}/{repo}/pulls/{number} — read one PR. Read. */
export async function getPull(conn: GithubConn, repo: string, number: number): Promise<GithubResult<GithubPull>> {
  if (!isValidRepoSlug(repo)) return { ok: false, reason: 'repo must be "owner/repo"' };
  const r = await ghGet(conn, `/repos/${repo}/pulls/${encodeURIComponent(String(number))}`);
  if (!r.ok) return r;
  return { ok: true, data: shapePull(r.data as Record<string, unknown>) };
}

/** GET /repos/{owner}/{repo}/commits — list commits. Read. */
export async function listCommits(conn: GithubConn, repo: string): Promise<GithubResult<GithubCommit[]>> {
  if (!isValidRepoSlug(repo)) return { ok: false, reason: 'repo must be "owner/repo"' };
  const r = await ghGetPaged(conn, `/repos/${repo}/commits?per_page=${GITHUB_PER_PAGE}`);
  if (!r.ok) return r;
  const rows = (r.data as Record<string, unknown>[]).map((d) => {
    const commit = (d.commit ?? {}) as Record<string, unknown>;
    const author = (commit.author ?? {}) as Record<string, unknown>;
    return {
      sha: String(d.sha ?? ''),
      message: String(commit.message ?? ''),
      author: String(author.name ?? ''),
      date: String(author.date ?? ''),
    };
  });
  return { ok: true, data: rows, truncated: r.truncated };
}

// ---------------------------------------------- writes (Write-approval) ---------

/**
 * Dedupe guard: GitHub has NO idempotency key for issue/PR creation, so before
 * creating we look for a recent OPEN item with the same title (and, for issues, the
 * same body). A found match returns it instead of opening a duplicate — so a retry
 * of an approved write can't double-open. Honest §5 idempotency, degraded to a guard.
 */
async function findOpenIssueByTitle(conn: GithubConn, repo: string, title: string): Promise<GithubIssue | null> {
  const existing = await listIssues(conn, repo, { state: 'open' });
  if (!existing.ok) return null;
  // An OPEN issue with the same title is a duplicate signal — a retry can't double-open.
  return existing.data.find((i) => i.title === title) ?? null;
}

/**
 * POST /repos/{owner}/{repo}/issues — create an issue. Dedupes on title to avoid a
 * double-open on retry. Write — Write-approval upstream. Never throws.
 */
export async function createIssue(
  conn: GithubConn,
  repo: string,
  input: { title: string; body?: string },
): Promise<GithubResult<GithubIssue & { deduped?: boolean }>> {
  if (!isValidRepoSlug(repo)) return { ok: false, reason: 'repo must be "owner/repo"' };
  if (!input.title.trim()) return { ok: false, reason: 'create_issue needs a title' };
  const dup = await findOpenIssueByTitle(conn, repo, input.title);
  if (dup) return { ok: true, data: { ...dup, deduped: true } };
  const r = await ghSend(conn, 'POST', `/repos/${repo}/issues`, { title: input.title, body: input.body ?? '' });
  if (!r.ok) return r;
  return { ok: true, data: shapeIssue(r.data as Record<string, unknown>) };
}

/**
 * POST /repos/{owner}/{repo}/issues/{number}/comments — comment on an issue/PR.
 * Write — Write-approval upstream. Never throws.
 */
export async function addIssueComment(
  conn: GithubConn,
  repo: string,
  number: number,
  body: string,
): Promise<GithubResult<{ id: number; url: string }>> {
  if (!isValidRepoSlug(repo)) return { ok: false, reason: 'repo must be "owner/repo"' };
  if (!body.trim()) return { ok: false, reason: 'add_issue_comment needs a body' };
  const r = await ghSend(conn, 'POST', `/repos/${repo}/issues/${encodeURIComponent(String(number))}/comments`, { body });
  if (!r.ok) return r;
  const d = r.data as Record<string, unknown>;
  return { ok: true, data: { id: Number(d.id ?? 0), url: String(d.html_url ?? '') } };
}

/**
 * POST /repos/{owner}/{repo}/pulls — open a pull request. Dedupes on title to avoid
 * a double-open on retry. Write — Write-approval upstream. Never throws.
 */
export async function createPullRequest(
  conn: GithubConn,
  repo: string,
  input: { title: string; head: string; base: string; body?: string },
): Promise<GithubResult<GithubPull & { deduped?: boolean }>> {
  if (!isValidRepoSlug(repo)) return { ok: false, reason: 'repo must be "owner/repo"' };
  if (!input.title.trim() || !input.head.trim() || !input.base.trim()) {
    return { ok: false, reason: 'create_pull_request needs title, head and base' };
  }
  const existing = await listPulls(conn, repo, { state: 'open' });
  if (existing.ok) {
    const dup = existing.data.find((p) => p.title === input.title && p.head === input.head && p.base === input.base);
    if (dup) return { ok: true, data: { ...dup, deduped: true } };
  }
  const r = await ghSend(conn, 'POST', `/repos/${repo}/pulls`, {
    title: input.title,
    head: input.head,
    base: input.base,
    body: input.body ?? '',
  });
  if (!r.ok) return r;
  return { ok: true, data: shapePull(r.data as Record<string, unknown>) };
}

// ------------------------------------------------------- server-side bridge -----

/** Build the pure client config from a resolved `github` connection. The token is
 *  dereferenced from the vault HERE and never leaves the server. */
export function githubConnFrom(c: Connection): GithubConn {
  return {
    baseUrl: c.endpoint || GITHUB_API,
    token: getSecretServerSide(c.secretRef) ?? undefined,
    fetchImpl: fetch,
    timeoutMs: 6000,
  };
}

/** Resolve a `github` connection the caller may see (id from the UI/MCP).
 *  Throws 404 for an unseeable id (no existence leak); 400 for the wrong type. */
export async function resolveGithub(connId: string, user: CurrentUser): Promise<Connection> {
  const c = await getConnectionForUser(connId, user); // DLS guard (404)
  if (c.template !== 'github') {
    const e = new Error('Not a GitHub connection') as Error & { status?: number };
    e.status = 400;
    throw e;
  }
  return c;
}
