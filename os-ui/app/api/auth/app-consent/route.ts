/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    App Builder (E) - My Settings: the apps I allowed to act as me, and taking it back
 * USER STORY: As a user I see every app I signed in to with what I allowed, and I can revoke one; its next call
 *             as me is refused.
 * ARCHITECTURE: GET lists the signed-in user's consents (own records only); DELETE `{ key }` revokes one after OPA
 *               (`authorize` with `app_consent_write`, own record only) and is audited. Session only: an app token is
 *               never accepted here (not on the app route allowlist). `app_builder_disabled` while off.
 */
import { NextResponse } from 'next/server';
import { appBuilderDisabledResponse } from '@core/kernel/app-builder-flag';
import { requireUser } from '@core/kernel/auth';
import { rateLimit } from '@core/kernel/ratelimit';
import { appConsentWriteDecision, authorize } from '@core/infra/governed';
import { listConsents, revokeConsent } from '@core/auth/app-consent';
import { auditAppEvent } from '@core/auth/app-identity';

export const dynamic = 'force-dynamic';

async function signedIn() {
  try {
    return await requireUser();
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: (e as { status?: number }).status ?? 401 });
  }
}

export async function GET(): Promise<Response> {
  const off = appBuilderDisabledResponse();
  if (off) return off;
  const user = await signedIn();
  if (user instanceof Response) return user;
  if (user.via) return NextResponse.json({ error: 'not available to an app' }, { status: 403 });
  const consents = await listConsents(user.id);
  if (consents === undefined) return NextResponse.json({ error: 'Your app permissions cannot be read right now. Try again in a moment.' }, { status: 503 });
  return NextResponse.json({ consents });
}

export async function DELETE(req: Request): Promise<Response> {
  const off = appBuilderDisabledResponse();
  if (off) return off;
  const user = await signedIn();
  if (user instanceof Response) return user;
  if (user.via) return NextResponse.json({ error: 'not available to an app' }, { status: 403 });
  if (!rateLimit(`app-consent-revoke:${user.id}`, 30, 60_000).ok) return NextResponse.json({ error: 'Too many requests' }, { status: 429 });
  let body: { key?: unknown } | null;
  try {
    body = (await req.json()) as { key?: unknown } | null;
  } catch {
    return NextResponse.json({ error: 'the body must be JSON: { "key": "<domain>/<slug>:<env>" }' }, { status: 400 });
  }
  const key = typeof body?.key === 'string' ? body.key : '';
  const m = /^([^/\s]+)\/([^/:\s]+):(dev|prod)$/.exec(key);
  if (!m) return NextResponse.json({ error: 'key must be <domain>/<slug>:<env>' }, { status: 400 });
  const authz = await authorize(`user:${user.id}`, 'app.consent.revoke', appConsentWriteDecision(user, 'revoke', { app: `${m[1]}/${m[2]}`, env: m[3] }));
  if (!authz.allowed) {
    return NextResponse.json({ error: 'Policy did not allow this change (or the policy engine did not answer). Nothing was changed.' }, { status: 403 });
  }
  const r = await revokeConsent(user.id, key);
  if (!r.ok) return NextResponse.json({ error: 'The permission could not be revoked right now. Try again in a moment.' }, { status: 503 });
  if (r.revoked) {
    auditAppEvent({
      event: 'app.consent.revoke',
      actor: user.id,
      app: { id: r.revoked.appId, domain: r.revoked.domain, slug: r.revoked.slug },
      env: r.revoked.env,
      outcome: 'allow',
      ...(authz.decisionId ? { decisionId: authz.decisionId } : {}),
      ...(authz.policyRev ? { policyRev: authz.policyRev } : {}),
    });
  }
  return NextResponse.json({ ok: true, revoked: Boolean(r.revoked) });
}
