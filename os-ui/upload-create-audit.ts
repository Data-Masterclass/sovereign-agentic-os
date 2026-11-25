/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The audit record of an upload door's refused create (OPA `upload_create`)
 * USER STORY: As a platform owner I want every create an upload door refused — Files, Data,
 *             Knowledge — to leave one audit record naming who, what, which door, and whether
 *             policy said no or did not answer, with the OPA decision it was enforced on.
 * ARCHITECTURE:
 *   - Lives beside `instrumentation.ts` (like `chat-attachment-sinks.ts`) because the platform
 *     audit store is the Admin tab's and the doors are three other tabs' routes; a route may
 *     export only its handlers, so the shared shape lives here. The chat attachment door audits
 *     every file (allowed or not) through its own wiring with the same `policy` / decision fields.
 */
import 'server-only';
import type { Authz, UploadCreateKind } from '@core/infra/governed';
import type { Role } from '@core/kernel/session';
import { audit } from '@tabs/admin/lib/audit';
import { currentTenantId } from '@tabs/admin/lib/tenant';

export function auditUploadCreateRefused(
  user: { id: string; role: Role },
  kind: UploadCreateKind,
  door: string,
  authz: Authz,
): void {
  audit({
    tenant: currentTenantId(),
    actor: user.id,
    role: user.role,
    action: 'upload.create',
    target: `${kind}:${door}`,
    detail: authz.policy === 'opa-unreachable'
      ? `Refused at ${door}: the policy engine did not answer (never fails open); nothing was written`
      : `Refused at ${door}: policy did not allow creating a ${kind} in My scope; nothing was written`,
    result: 'denied',
    data: { kind, door, policy: authz.policy, scope: 'my' },
    ...(authz.decisionId ? { decisionId: authz.decisionId } : {}),
    ...(authz.policyRev ? { policyRev: authz.policyRev } : {}),
  });
}
