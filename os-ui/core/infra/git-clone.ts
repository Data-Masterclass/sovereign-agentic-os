/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The `git clone` command for a domain's repository — the transparency affordance
 * USER STORY: As an engineer looking at any dataset, agent system or dashboard I want the exact
 *             `git clone` command for the repository that holds its files, and the path of the
 *             file itself, so the OS is never a black box and I can keep working in VS Code
 *             (E-R1.9, checklist E10).
 * ARCHITECTURE:
 *   - PURE string building, no I/O and no React, so the one thing that can be wrong — the URL — is
 *     unit-tested. `core/ui/git-clone/CloneRepository.tsx` is the component the detail pages mount;
 *     it calls these functions and nothing else.
 *   - The remote is ALWAYS `<base>/git/<domain>.git`, the single ingress path the `git http-backend`
 *     sidecar serves. `base` is `OS_PUBLIC_URL` when the operator set it; otherwise the caller
 *     passes the browser's own origin, because a relative git remote is meaningless and inventing
 *     a hostname would be a fabricated instruction.
 *   - READ IS UNCONDITIONAL (the coin's transparency half): the hint says the whole repository is
 *     readable — `os/*.yml` governance metadata included — and that a push is gated. It never
 *     claims a capability the caller may not have.
 */

/** The path segment the chart's ingress routes to the git sidecar. */
export const GIT_HTTP_PATH = 'git';

/**
 * `https://os.example.com/git/sales.git`, or null when there is no base to build it from.
 *
 * HTTPS ONLY (review M-6). The credential travels in the request, so a `http://` remote would
 * publish an OS access token on the wire; the git Ingress carries `force-ssl-redirect` for the
 * same reason. The single exception is LOOPBACK (`http://localhost`, `http://127.0.0.1`), where
 * there is no wire — that is `npm run dev`, and refusing it would just make the panel lie.
 */
export function cloneUrl(domain: string, base: string | null | undefined): string | null {
  const d = String(domain ?? '').trim();
  if (!d || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(d) || d.includes('..')) return null;
  const b = String(base ?? '').trim().replace(/\/+$/, '');
  if (!b) return null;
  const https = /^https:\/\//i.test(b);
  const loopback = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(b);
  if (!https && !loopback) return null;
  return `${b}/${GIT_HTTP_PATH}/${d}.git`;
}

/** The command an engineer runs. `null` when the URL cannot be built — never a half command. */
export function cloneCommand(domain: string, base: string | null | undefined): string | null {
  const url = cloneUrl(domain, base);
  return url ? `git clone ${url}` : null;
}

/**
 * A link to one file's BYTES in the repository — what T's engineering panel uses for "open this
 * file in the repo". It points at the existing, domain-gated read API
 * (`/api/data/projects/<domain>/blob?ref=&path=`) and not at a UI page, because that is the route
 * that actually resolves today: a deep link that cannot resolve says why, it is never invented.
 * Relative on purpose — it is an OS route, not a git remote.
 */
export function repoFileHref(domain: string, filePath: string, ref?: string): string | null {
  const d = String(domain ?? '').trim();
  const p = String(filePath ?? '').trim().replace(/^\/+/, '');
  if (!d || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(d) || d.includes('..')) return null;
  if (!p || p.split('/').some((s) => s === '' || s === '.' || s === '..')) return null;
  const q = new URLSearchParams({ path: p });
  if (ref) q.set('ref', ref);
  return `/api/data/projects/${encodeURIComponent(d)}/blob?${q.toString()}`;
}

/** What the UI tells the engineer about credentials. One sentence, no token in it, ever. */
export const CLONE_TOKEN_HINT =
  'Authenticate with an OS personal access token (Platform → Access tokens): use it as the password, any username. Reading the whole repository — os/*.yml governance metadata included — needs nothing more than access to the domain; pushing is validated by the OS.';
