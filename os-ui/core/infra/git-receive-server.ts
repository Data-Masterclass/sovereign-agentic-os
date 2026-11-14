/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The HTTP half of the receive gate — one handler, three phases, authenticated on all
 * USER STORY: As the owner I want the endpoint the push hooks call to be unreachable by anyone
 *             without a valid OS access token, on EVERY phase — so an endpoint that holds a lock
 *             and reconciles the registry can never be driven from the internet (review H-1).
 * ARCHITECTURE:
 *   - `app/api/git/receive/route.ts` is a SHELL over `handleReceive`; the logic lives here so the
 *     real-push test can serve it over a plain `node:http` server (a test may not import a route).
 *   - FAIL CLOSED, in this order: a valid OS personal access token for a member of the domain is
 *     REQUIRED on `pre`, `post` AND `abort` — the earlier version gated `post`/`abort` on the
 *     service bearer alone, which is empty by default, so they were open. The service bearer is an
 *     ADDITIONAL requirement when one is configured, never a substitute.
 *   - `post` and `abort` additionally require the authenticated principal to be the one holding the
 *     lease, so one member of a domain cannot complete or release another's push.
 *   - The hook posts base64 blob content (any bytes survive JSON); it is decoded here, once.
 *   - The response BODY is the sentence the developer reads on their terminal and the STATUS is
 *     the verdict, so the hook parses no JSON. Every message goes through `redact`.
 */
import { redact } from '@core/auth/access-tokens';
import { authenticateGitRequest, type GitPrincipal } from '@core/auth/git-http-auth';
import {
  abortReceive,
  beginReceive,
  completeReceive,
  leaseHolder,
  MAX_FILE_BYTES,
  MAX_PUSH_BYTES,
  personalLanes,
  type ChangedFile,
  type GateDeps,
  type Pusher,
  type RefUpdate,
} from '@core/infra/git-receive';

export type ReceiveBody = {
  phase?: unknown;
  domain?: unknown;
  updates?: unknown;
  files?: unknown;
};

export type ReceiveHeaders = {
  /** The pusher's own `Authorization`, forwarded by the hook. */
  gitAuthorization: string | null;
  /** The service bearer the hook sends when one is configured. */
  authorization: string | null;
};

export type ReceiveDeps = GateDeps & {
  lookup: (id: string) => Promise<GitPrincipal | null>;
  /** Every active principal id, for the personal-lane collision guard (review M-7). */
  principalIds?: () => Promise<string[]>;
  /** `config.serviceBearerToken`; an empty value means none is configured. */
  serviceBearerToken?: string;
};

export type ReceiveResult = { status: number; body: string };

const text = (status: number, body: string): ReceiveResult => ({ status, body: redact(body.endsWith('\n') ? body : `${body}\n`) });

/** Decode one hook-reported file. Oversize content is refused, never truncated. */
function decodeFile(raw: unknown): ChangedFile | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const p = typeof r.path === 'string' ? r.path : '';
  if (!p) return 'the receive hook reported a file with no path';
  const status = r.status === 'added' || r.status === 'deleted' ? r.status : 'modified';
  if (status === 'deleted' || r.content === null || r.content === undefined) return { path: p, status, content: null };
  if (typeof r.content !== 'string') return `the receive hook reported '${p}' with unreadable content`;
  const bytes = Buffer.from(r.content, 'base64');
  if (bytes.length > MAX_FILE_BYTES) return `'${p}' is larger than this door accepts (${MAX_FILE_BYTES} bytes)`;
  return { path: p, status, content: bytes.toString('utf8') };
}

/**
 * One handler for all three phases. `pre` gates, `post` reconciles and releases, `abort` releases.
 */
export async function handleReceive(body: ReceiveBody, headers: ReceiveHeaders, deps: ReceiveDeps): Promise<ReceiveResult> {
  const phase = body.phase === 'post' || body.phase === 'abort' ? body.phase : 'pre';
  const domain = typeof body.domain === 'string' ? body.domain : '';
  if (!domain) return text(400, 'the receive hook sent no repository name');

  // Defence in depth behind the NetworkPolicy, when a service bearer is configured. It is never a
  // SUBSTITUTE for the token check below — the token is required either way.
  const bearer = deps.serviceBearerToken ?? '';
  if (bearer && headers.authorization !== `Bearer ${bearer}`) {
    return text(403, 'this endpoint is for the OS receive hook');
  }

  // EVERY phase is authenticated as the pusher. `post` and `abort` hold a lock and write to the
  // registry; neither may be reachable without the credential that opened the push.
  const auth = await authenticateGitRequest(
    { authorization: headers.gitAuthorization, uri: `/git/${domain}.git/git-receive-pack` },
    { lookup: deps.lookup },
  );
  if (!auth.ok) {
    console.warn(`git-receive(${phase}): ${auth.status} — ${auth.logReason}`);
    return text(auth.status, auth.message);
  }

  if (phase === 'post' || phase === 'abort') {
    const holder = leaseHolder(domain);
    if (holder && holder !== auth.principal.id) {
      console.warn(`git-receive(${phase}): 403 — ${auth.principal.id} tried to ${phase} a lease held by ${holder}`);
      return text(403, 'this push belongs to someone else');
    }
    if (phase === 'abort') {
      abortReceive(domain);
      return text(200, 'the OS released its lock on this repository');
    }
    const done = await completeReceive(domain, deps);
    // The push has landed by now; the report is information, not a verdict — a non-200 here would
    // only tell the developer their push failed when it did not.
    return text(200, done.message);
  }

  const ids = deps.principalIds ? await deps.principalIds().catch(() => []) : [];
  const pusher: Pusher = {
    id: auth.principal.id,
    name: auth.principal.name,
    role: auth.principal.role as Pusher['role'],
    domains: auth.principal.domains,
    lanes: personalLanes(auth.principal.id, ids),
  };

  const updates = (Array.isArray(body.updates) ? body.updates : [])
    .map((u) => u as Record<string, unknown>)
    .filter((u) => typeof u.ref === 'string' && typeof u.oldSha === 'string' && typeof u.newSha === 'string')
    .map(
      (u) =>
        ({
          ref: String(u.ref),
          oldSha: String(u.oldSha),
          newSha: String(u.newSha),
          fastForward: u.fastForward === true,
        }) as RefUpdate,
    );
  if (updates.length === 0) return text(400, 'the receive hook sent no ref updates');

  if (!Array.isArray(body.files)) return text(400, 'the receive hook sent no file list — nothing was changed');
  const changed: ChangedFile[] = [];
  let total = 0;
  for (const raw of body.files) {
    const decoded = decodeFile(raw);
    if (typeof decoded === 'string') return text(413, decoded);
    total += decoded.content ? Buffer.byteLength(decoded.content, 'utf8') : 0;
    if (total > MAX_PUSH_BYTES) return text(413, `this push changes more than ${MAX_PUSH_BYTES} bytes of content; split it into smaller pushes`);
    changed.push(decoded);
  }

  const decision = await beginReceive({ domain, pusher, updates, changed }, deps);
  if (!decision.ok) return text(decision.status, decision.message);
  const unmatched = decision.unmatched.length
    ? ` ${decision.unmatched.length} file(s) map to no OS object and are stored as files only: ${decision.unmatched.slice(0, 10).join(', ')}.`
    : '';
  return text(200, `the OS accepted ${decision.changed.length} file change(s) as ${pusher.id}; reconciling the registry from them.${unmatched}`);
}
