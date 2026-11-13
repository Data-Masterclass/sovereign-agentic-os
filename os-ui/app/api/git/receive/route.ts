/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * The ONE endpoint every `git push` passes (decision D28). A SHELL: `core/infra/git-receive.ts`
 * holds the per-domain lock, decides and ingests; this file shapes HTTP. The response BODY is the
 * message the developer sees on their terminal and the STATUS is the verdict, so the hook parses
 * no JSON.
 *
 *   phase: 'pre'   → take the lock, refuse a rewrite, check path ownership, run the validators
 *   phase: 'post'  → reconcile the registry from the files, release the lock
 *   phase: 'abort' → release the lock (receive-pack failed after the gate said yes)
 *
 * The pusher is authenticated HERE, from the Authorization header their git client sent (forwarded
 * by the hook as `x-os-git-authorization`), so the gate never trusts a claimed identity.
 */
import { NextResponse } from 'next/server';
import { config } from '@core/kernel/config';
import { principalById } from '@core/kernel/auth';
import { authenticateGitRequest } from '@core/auth/git-http-auth';
import { ensureHydrated } from '@core/auth/access-tokens-store';
import { abortReceive, beginReceive, completeReceive, personalLanes, type Pusher, type RefUpdate } from '@core/infra/git-receive';

export const dynamic = 'force-dynamic';

const text = (body: string, status: number) =>
  new NextResponse(body.endsWith('\n') ? body : `${body}\n`, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });

export async function POST(req: Request): Promise<NextResponse> {
  // Defence in depth behind the NetworkPolicy: the hook runs in the sidecar on this pod and
  // carries the service bearer when one is configured (the same posture as the data-plane
  // services — see core/infra/service-bearer.ts).
  const expected = config.serviceBearerToken;
  if (expected && req.headers.get('authorization') !== `Bearer ${expected}`) {
    return text('this endpoint is for the OS receive hook', 403);
  }
  const body = (await req.json().catch(() => ({}))) as {
    phase?: unknown;
    domain?: unknown;
    updates?: unknown;
  };
  const phase = body.phase === 'post' || body.phase === 'abort' ? body.phase : 'pre';
  const domain = typeof body.domain === 'string' ? body.domain : '';
  if (!domain) return text('the receive hook sent no repository name', 400);

  if (phase === 'abort') {
    abortReceive(domain);
    return text('the OS released its lock on this repository', 200);
  }
  if (phase === 'post') {
    const done = await completeReceive(domain);
    return text(done.message, 200); // the push has landed; the report is information, not a verdict
  }

  await ensureHydrated();
  const auth = await authenticateGitRequest(
    { authorization: req.headers.get('x-os-git-authorization'), uri: `/git/${domain}.git/git-receive-pack` },
    { lookup: principalById },
  );
  if (!auth.ok) {
    console.warn(`git-receive: ${auth.status} — ${auth.logReason}`);
    return text(auth.message, auth.status);
  }
  const pusher: Pusher = {
    id: auth.principal.id,
    name: auth.principal.name,
    role: auth.principal.role as Pusher['role'],
    domains: auth.principal.domains,
    lanes: personalLanes(auth.principal.id),
  };
  const updates = (Array.isArray(body.updates) ? body.updates : [])
    .map((u) => u as Record<string, unknown>)
    .filter((u) => typeof u.ref === 'string' && typeof u.oldSha === 'string' && typeof u.newSha === 'string')
    .map((u) => ({ ref: String(u.ref), oldSha: String(u.oldSha), newSha: String(u.newSha) }) as RefUpdate);
  if (updates.length === 0) return text('the receive hook sent no ref updates', 400);

  const decision = await beginReceive({ domain, pusher, updates }, {});
  if (!decision.ok) return text(decision.message, decision.status);
  return text(
    `the OS accepted ${decision.changed.length} file change(s) as ${pusher.id}; reconciling the registry from them`,
    200,
  );
}
