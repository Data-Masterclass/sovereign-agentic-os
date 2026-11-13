/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Authenticating a git-over-HTTP request against an OS personal access token
 * USER STORY: As an engineer I want `git clone https://<os>/git/<domain>.git` to work with my OS
 *             token and to read EVERYTHING in the repository, and I want no token, an expired one
 *             or a revoked one to be a plain 401 (E-R1.1, E-R1.3, E-R1.8).
 * ARCHITECTURE:
 *   - Pure decision + one injected lookup, so every case is a unit test with no cluster: the
 *     ingress's `auth-url` sub-request and the receive hook's call both reduce to this function.
 *   - READ IS UNCONDITIONAL for a member of the domain — the whole tree, `os/*.yml` included. No
 *     path filter, no per-file ACL: transparency must never require write access.
 *   - It resolves a token to a USER ID and then re-reads the LIVE principal (role and domains as
 *     they are NOW). A token is a credential, never a frozen snapshot of authority — the same
 *     discipline `principalById` exists for in the agent engine.
 *   - Every failure is the SAME 401 body. The server knows whether it was unknown, revoked or
 *     expired; the client is told only "authentication failed", and the token never appears in
 *     either (E-R2.3).
 */
import { redact, tokenFromAuthorization } from '@core/auth/access-tokens';
import { resolveAccessToken } from '@core/auth/access-tokens-store';

export type GitService = 'upload-pack' | 'receive-pack' | 'unknown';

export type GitRequestTarget = { domain: string; service: GitService };

export type GitPrincipal = { id: string; name: string; role: string; domains: string[] };

export type GitAuthOutcome =
  | { ok: true; principal: GitPrincipal; target: GitRequestTarget; tokenPrefix: string }
  | { ok: false; status: 401 | 403 | 404; message: string; logReason: string };

/** The one 401 body. Identical for every authentication failure, on purpose. */
export const AUTH_FAILED = 'authentication failed — create an OS personal access token in Platform → Access tokens and use it as the password';

/**
 * `/git/<domain>.git/info/refs?service=git-receive-pack` → `{ domain, service }`.
 * Anything that is not a `/git/<domain>.git/...` URL is `null`, which is a 404: this server has
 * exactly one shape of URL.
 */
export function parseGitPath(uri: string): GitRequestTarget | null {
  const pathOnly = String(uri ?? '').split('#')[0];
  const [p, query = ''] = pathOnly.split('?');
  const m = /^\/git\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\.git(\/.*)?$/.exec(p);
  if (!m || m[1].includes('..')) return null;
  const rest = m[2] ?? '';
  let service: GitService = 'unknown';
  if (/(^|&)service=git-receive-pack(&|$)/.test(query) || rest.endsWith('/git-receive-pack')) service = 'receive-pack';
  else if (/(^|&)service=git-upload-pack(&|$)/.test(query) || rest.endsWith('/git-upload-pack')) service = 'upload-pack';
  // `GET /info/refs` with no service, and the dumb-protocol file paths, are READS.
  else if (rest === '' || rest.startsWith('/info/refs') || rest.startsWith('/objects/') || rest.startsWith('/HEAD')) service = 'upload-pack';
  return { domain: m[1], service };
}

/**
 * Decide one git-over-HTTP request. `lookup` is `principalById` in production.
 * Domain membership is the ONLY gate here; which PATHS a push may change is the receive gate's
 * decision (`core/infra/git-receive.ts` `decidePath`), because that needs the files.
 */
export async function authenticateGitRequest(
  input: { authorization: string | null | undefined; uri: string },
  deps: { lookup: (id: string) => Promise<GitPrincipal | null>; now?: number },
): Promise<GitAuthOutcome> {
  const target = parseGitPath(input.uri);
  if (!target) {
    return { ok: false, status: 404, message: 'no such repository', logReason: `unroutable uri '${redact(String(input.uri ?? '')).slice(0, 120)}'` };
  }
  const presented = tokenFromAuthorization(input.authorization);
  if (!presented) {
    return { ok: false, status: 401, message: AUTH_FAILED, logReason: 'no token presented' };
  }
  const resolved = resolveAccessToken(presented, { scope: 'git', now: deps.now });
  if (!resolved.ok) {
    return { ok: false, status: 401, message: AUTH_FAILED, logReason: `token ${resolved.reason}` };
  }
  const principal = await deps.lookup(resolved.userId);
  if (!principal) {
    return { ok: false, status: 401, message: AUTH_FAILED, logReason: `token prefix ${resolved.prefix}: the user no longer exists or is disabled` };
  }
  const member = principal.role === 'admin' || principal.domains.includes(target.domain);
  if (!member) {
    // Not a 403: naming the repository would tell a stranger it exists.
    return {
      ok: false,
      status: 404,
      message: 'no such repository',
      logReason: `token prefix ${resolved.prefix}: ${principal.id} is not a member of ${target.domain}`,
    };
  }
  return { ok: true, principal, target, tokenPrefix: resolved.prefix };
}
