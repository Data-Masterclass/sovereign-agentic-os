/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    Who acted on a connection, and with whose credential
 * USER STORY: As an auditor I want every connection tool call, approval and sync run to say which
 *             OS user it ran for and whose credential it used, so a shared credential never hides
 *             the person behind a call, and I never find a secret in the audit trail.
 * ARCHITECTURE:
 *   - Pure, no I/O. `store.ts` (tool calls, approvals), the Home chat's Notion MCP path and the
 *     data sync executor build the kernel's `CallAttribution` here and put it on the trace, the
 *     audit detail and the Langfuse span.
 *   - Every connection today holds ONE credential: the owner's (or the service account it stands
 *     for). So `credentialMode` is `'shared'` and `credentialSubject` is the owner, for all of them.
 *   - `redactSecretArgs` (kernel, `core/infra/trace-masking.ts`) replaces the value of any argument
 *     whose KEY names a secret, at any depth, before args reach a trace. Connection secrets are
 *     injected server-side and never travel in args; this is the guard for one a caller typed in.
 */
import type { CallAttribution } from '@core/infra/agent-governed';
import { redactSecretArgs, REDACTED } from '@core/infra/trace-masking';

export type { CallAttribution };
export { redactSecretArgs, REDACTED };

/** The attribution of one call on connection `c`, acting for `actingUser`. */
export function connectionAttribution(
  c: { owner: string },
  actingUser: string,
  extra: Partial<Pick<CallAttribution, 'requestedBy' | 'approvedBy' | 'trigger' | 'schedule'>> = {},
): CallAttribution {
  const out: CallAttribution = { actingUser, credentialMode: 'shared', credentialSubject: c.owner };
  for (const k of ['requestedBy', 'approvedBy', 'trigger', 'schedule'] as const) {
    const v = extra[k];
    if (v) out[k] = v;
  }
  return out;
}
