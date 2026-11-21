/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Who is calling? A Kubernetes ServiceAccount token, checked by the API server (WP-15)
 * USER STORY: As an operator I want the Dagster run pods to prove which ServiceAccount they run as
 *             without any shared secret in their environment, so authored dbt code in a run pod
 *             holds nothing it could replay elsewhere.
 * ARCHITECTURE:
 *   - The caller sends its projected ServiceAccount token (audience `os-ui`, short-lived, rotated
 *     by the kubelet). os-ui asks the API server with a TokenReview
 *     (https://kubernetes.io/docs/reference/kubernetes-api/authentication-resources/token-review-v1/),
 *     which needs the `system:auth-delegator` ClusterRole for os-ui's own ServiceAccount.
 *   - Only `status.authenticated` with the requested audience counts. The API server's answer is
 *     the identity; os-ui never decodes the JWT itself.
 *   - Uses the one in-cluster client (`k8s.ts`), so tests point it at a real API server (kind).
 */
import 'server-only';
import { k8s } from '@core/infra/k8s';

export type Reviewed = { ok: true; username: string } | { ok: false; status: number; reason: string };

export async function reviewToken(token: string, audience: string): Promise<Reviewed> {
  if (!token) return { ok: false, status: 401, reason: 'no bearer token' };
  const r = await k8s('POST', '/apis/authentication.k8s.io/v1/tokenreviews', {
    apiVersion: 'authentication.k8s.io/v1',
    kind: 'TokenReview',
    spec: { token, audiences: [audience] },
  });
  if (r.status === 0) return { ok: false, status: 503, reason: 'the Kubernetes API is not reachable from os-ui' };
  if (r.status !== 201 && r.status !== 200) return { ok: false, status: 503, reason: `TokenReview answered HTTP ${r.status}` };
  const st = (r.body.status ?? {}) as { authenticated?: boolean; audiences?: string[]; user?: { username?: string }; error?: string };
  if (st.authenticated !== true) return { ok: false, status: 401, reason: 'the token is not valid for this audience' };
  if (!(st.audiences ?? []).includes(audience)) return { ok: false, status: 401, reason: 'the token is for another audience' };
  const username = st.user?.username ?? '';
  if (!username) return { ok: false, status: 401, reason: 'the token names no user' };
  return { ok: true, username };
}

/** `Authorization: Bearer <t>` → `<t>`, or ''. */
export function bearerOf(req: Request): string {
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '');
  return m ? m[1] : '';
}
