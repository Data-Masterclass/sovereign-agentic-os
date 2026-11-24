/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Connection attribution — who a connection call acted for, and with whose credential
 * USER STORY: As an auditor I want every connection tool call, approval, sync run and chat call to
 *             name the OS user it ran for and whose credential it used, so a shared credential never
 *             hides the person behind a call.
 * ARCHITECTURE:
 *   - Pure, no I/O. THE one shape (`ConnectionAttribution`) for every writer: the connections store
 *     (tool calls, approvals), the data sync executor, and the chat's external MCP door
 *     (`core/runtime/external-mcp.ts`). It sits at the TOP LEVEL of the governed trace event
 *     (`core/infra/agent-governed.ts` `TraceEvent`), which copies it into the Langfuse metadata.
 *   - Credential modes: `per_user` — each user's own sign-in (the subject is that user); `shared` —
 *     one credential the owner explicitly shared (the subject is the owner); `owner` — the owner's
 *     own credential, the default for every connection that does not say otherwise (all legacy
 *     single-credential connections).
 *   - Approvals and sync runs add `CallContext` (requester, approver, trigger, schedule) beside it.
 */

export type CredentialMode = 'per_user' | 'shared' | 'owner';

export type ConnectionAttribution = {
  /** The OS user id the call ran for (the caller, the approver, or a sync's dataset owner). */
  actingUser: string;
  credentialMode: CredentialMode;
  /** Whose credential it is: the acting user (`per_user`) or the connection owner (`shared` / `owner`). */
  credentialSubject: string;
  connectionId: string;
};

/** What an approval or a sync run adds to the attribution. */
export type CallContext = {
  requestedBy?: string;
  approvedBy?: string;
  /** A sync run: what started it (`schedule` / `manual` / `reset`) and the schedule's cron. */
  trigger?: string;
  schedule?: string;
};

/** A connection's credential mode: what it says, else `owner` (every legacy single-credential connection). */
export function effectiveCredentialMode(c: { credentialMode?: CredentialMode | string }): CredentialMode {
  return c.credentialMode === 'per_user' || c.credentialMode === 'shared' ? c.credentialMode : 'owner';
}

/**
 * The attribution of one call on connection `c` acting for `actingUser`. `subject` overrides the
 * per-user subject when the credential store knows a more precise one (e.g. the account it holds).
 */
export function connectionAttribution(
  c: { id: string; owner: string; credentialMode?: CredentialMode | string },
  actingUser: string,
  opts: { subject?: string } = {},
): ConnectionAttribution {
  const credentialMode = effectiveCredentialMode(c);
  const credentialSubject = credentialMode === 'per_user' ? opts.subject ?? actingUser : c.owner;
  return { actingUser, credentialMode, credentialSubject, connectionId: c.id };
}

/** `ctx` without its empty fields (never an `undefined` key in a trace). */
export function callContext(ctx: CallContext = {}): CallContext {
  const out: CallContext = {};
  for (const k of ['requestedBy', 'approvedBy', 'trigger', 'schedule'] as const) {
    const v = ctx[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

const ATTRIBUTION_KEYS = ['actingUser', 'credentialMode', 'credentialSubject', 'connectionId', 'requestedBy', 'approvedBy', 'trigger', 'schedule'] as const;

/** The attribution + context fields that are set, for Langfuse metadata (absent ones are left out). */
export function attributionMetadata(a: Partial<ConnectionAttribution & CallContext> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!a) return out;
  for (const k of ATTRIBUTION_KEYS) {
    const v = a[k];
    if (typeof v === 'string' && v) out[k] = v;
  }
  return out;
}
