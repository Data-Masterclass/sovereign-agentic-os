/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { config } from '@/lib/core/config';
import { realForgejoAdmin } from '@/lib/git/live-clients';
import { mintToken } from '@/lib/git/token-mint';

export const dynamic = 'force-dynamic';

/**
 * #146 Phase 2 (Option B — ADR 0006): the per-user Forgejo token MINT.
 * `POST /api/git/token`.
 *
 * AUTH: the CALLER's OS session (session principal via `requireUser` — anon → 401).
 * The token is minted for the caller's OWN mirrored Forgejo user and scoped to the
 * caller's domains' repos; the identity is taken from the signed session, NEVER from
 * the request body. GATED behind `gitTokenMintEnabled` (default OFF): when off, the
 * route reports it honestly and mints nothing.
 *
 * BODY (optional): `{ repos?: string[] }` — narrow/extend the scope to specific repo
 * names; each is filtered to repos the caller may access. Default scope: the shared
 * `analytics` monorepo.
 *
 * RESPONSE (the EXACT `sos git` contract):
 *   { token, username, expiresAt, scopes, forgejoBaseUrl }
 * The `token` is the opaque Forgejo access token, returned ONCE to the authenticated
 * caller over this governed channel. It is NEVER logged, stored in the registry, or
 * echoed anywhere else. The Forgejo ADMIN credential used to provision the user +
 * mint the token is the EXISTING mounted `forgejo*` secret (referenced via `config`,
 * never inlined/logged).
 *
 * REVOKE: tokens are short-TTL (the OS's revoke-by `expiresAt`) and centrally
 * revocable — each mint sweeps the caller's prior OS-minted tokens, and the token
 * name carries its mint epoch so a sweep can identify stale ones. REVOKE-ON-
 * DEACTIVATION HOOK POINT: on user deactivation, call
 * `realForgejoAdmin().deleteTokensByPrefix(forgejoUsername(uid), tokenNamePrefix(...))`
 * from the users-admin deactivate path. TODO(users-admin): wire that trigger — it
 * needs the deactivate flow in `lib/platform-admin/users.ts`, out of this lane.
 *
 * LIVE-VERIFY-PENDING: real Forgejo user-create + scoped-token mint + a raw
 * `git push` with the minted token need a live Forgejo (kind/STACKIT).
 */

export async function POST(req: Request) {
  let user;
  try {
    user = await requireUser(); // 401 when anon (never mints for an unauthenticated caller)
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 401;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }

  if (!config.gitTokenMintEnabled) {
    return NextResponse.json(
      { error: 'Git token mint is disabled (GIT_TOKEN_MINT_ENABLED is not true).' },
      { status: 403 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as { repos?: unknown };
  const repos = Array.isArray(body.repos) ? body.repos.map(String) : undefined;

  // The desktop git helper clones/pushes against the BROWSER-reachable Forgejo host
  // (its console URL on a deploy) — fall back to the in-cluster URL locally so the
  // contract still carries a usable base. Never the admin cred, only the base URL.
  const forgejoBaseUrl = config.forgejoConsoleUrl || config.forgejoUrl;

  try {
    const result = await mintToken(
      realForgejoAdmin(),
      { id: user.id, domains: user.domains },
      { forgejoBaseUrl, ttlSeconds: config.gitTokenTtlSeconds },
      { repos },
    );
    // The token rides ONLY in this response body, once. Nothing here logs it.
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    // Errors carry only the admin-client's status/path text (see live-clients.ts) —
    // never the admin credential or a token value.
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
