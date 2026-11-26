/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    The Policy data card's view model and copy — in sync / refused, what is removed, the
 *             acknowledgement's reason rule, the confirmation text and the 409 answer
 * USER STORY: As an admin I want the card to say plainly whether OPA is current, and before I accept a
 *             refused update, to read exactly which principals and tables it removes.
 * ARCHITECTURE:
 *   - A `.ts` sibling of `tabs/admin/ui/PolicyData.tsx`, because a test cannot import a `.tsx`
 *     (the `reindex-view.ts` / `sections.ts` pattern). PURE: no fetch, no React; the clock is passed in.
 *   - I18N: the English strings stay the exports tests read; the card renders through the `*_KEY` maps and the
 *     structured `confirmParts` / `ackFailureCode` / `agoMinutes` (catalog `admin.policy.*`).
 *   - The shapes mirror `GET /api/platform-admin/opa-bundle` (tabs/admin/lib/opa-bundle-admin.ts) as
 *     plain types, so the client bundle never imports the server module.
 */

export type PrincipalState = 'deactivated' | 'disabled' | 'no-domain' | 'active' | 'unknown';
export type ListDiff = { removed: string[]; added: string[]; removedTotal: number; addedTotal: number };
export type BundleDiff = { grantPrincipals: ListDiff; governancePrincipals: ListDiff; tables: ListDiff };
export type Counts = { grants: number; principals: number; tables: number };
export type RefusalView = {
  hash: string;
  stats: Counts;
  baseStats: Counts | null;
  reasons: string[];
  at: string;
  since: string;
  maxDropPercent: number;
  diff: BundleDiff | null;
};
export type HistoryRowView = {
  at: string;
  kind: 'refused' | 'refusal-changed' | 'ack-requested' | 'acknowledged' | 'ack-failed' | 'recovered' | 'denied';
  actor: string;
  hash: string;
  reason: string;
  counts: Partial<Counts> | null;
  detail: string;
};
export type PolicyDataView = {
  revision: string | null;
  compiledAt: string | null;
  checkedAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  refused: RefusalView | null;
  maxDropPercent: number;
  refusalAlertMinutes: number;
  annotations: Record<string, PrincipalState>;
  directoryAuthoritative: boolean;
  alert: { title: string; detail: string } | null;
  history: HistoryRowView[];
};

/** Must match `MIN_REASON_LENGTH` in opa-bundle-admin.ts (asserted by the test). */
export const MIN_REASON_LENGTH = 10;

export const STATE_LABEL: Record<PrincipalState, string> = {
  deactivated: 'deactivated on Access',
  disabled: 'disabled',
  'no-domain': 'no longer in a domain',
  active: 'still active — check why it is removed',
  unknown: 'unknown to the directory',
};

/** Catalog leaf per state, for `admin.policy.principalState.<key>` (the UI's translated STATE_LABEL). */
export const STATE_KEY = {
  deactivated: 'deactivated',
  disabled: 'disabled',
  'no-domain': 'noDomain',
  active: 'active',
  unknown: 'unknown',
} as const satisfies Record<PrincipalState, string>;

/** Badge class per state (design system `.badge ok|warn|err`). */
export const STATE_BADGE: Record<PrincipalState, string> = {
  deactivated: 'ok',
  disabled: 'ok',
  'no-domain': 'ok',
  active: 'err',
  unknown: 'warn',
};

export const LIST_LABEL: Record<keyof BundleDiff, string> = {
  grantPrincipals: 'Grant principals',
  governancePrincipals: 'Governance principals',
  tables: 'Governance tables',
};

/** Catalog leaf per list, for `admin.policy.list.<key>` (the UI's translated LIST_LABEL). */
export const LIST_KEY = {
  grantPrincipals: 'grantPrincipals',
  governancePrincipals: 'governancePrincipals',
  tables: 'tables',
} as const satisfies Record<keyof BundleDiff, string>;

export type SyncState =
  | { kind: 'none'; headline: string; sub: string }
  | { kind: 'in-sync'; headline: string; sub: string }
  | { kind: 'refused'; headline: string; sub: string }
  | { kind: 'error'; headline: string; sub: string };

/** Whole minutes since `iso` (never negative) — the number behind the "(… min)" in the refused headline. */
export function agoMinutes(iso: string, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - Date.parse(iso)) / 60_000));
}

function ago(iso: string, nowMs: number): string {
  const min = agoMinutes(iso, nowMs);
  if (min < 1) return 'less than a minute';
  if (min < 120) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function syncState(v: PolicyDataView, nowMs: number, fmt: (iso: string) => string = (s) => new Date(s).toLocaleString()): SyncState {
  if (v.refused) {
    return {
      kind: 'refused',
      headline: `Refused since ${fmt(v.refused.since)} (${ago(v.refused.since, nowMs)})`,
      sub: `OPA keeps revision ${v.revision ?? '(none)'}. No access change made since then reaches OPA until an admin reviews and acknowledges the new content.`,
    };
  }
  if (!v.revision) {
    return { kind: 'none', headline: 'No policy data served yet', sub: v.lastError ? `Last compile failed: ${v.lastError}` : 'The os-data bundle has not compiled in this os-ui process (bundle mode off, or starting).' };
  }
  if (v.lastError) {
    return { kind: 'error', headline: 'Last compile failed', sub: `OPA keeps revision ${v.revision}. ${v.lastError}` };
  }
  return { kind: 'in-sync', headline: 'In sync', sub: `OPA is served revision ${v.revision}.` };
}

/** Null when the reason is acceptable; otherwise what to tell the admin. */
export function reasonError(reason: string): string | null {
  const n = reason.trim().length;
  if (n >= MIN_REASON_LENGTH) return null;
  return `Give a reason of at least ${MIN_REASON_LENGTH} characters (${n} so far). It is kept in the audit trail.`;
}

/** One line of the confirmation, as data — the UI translates it, `confirmLines` writes the English. */
export type ConfirmPart =
  | { kind: 'served'; hash: string }
  | { kind: 'noDiff' }
  | { kind: 'counts'; base: Counts; now: Counts }
  | { kind: 'list'; list: keyof BundleDiff; removedTotal: number; shown: { id: string; state: PrincipalState | null }[]; more: number }
  | { kind: 'nothingRemoved' };

/**
 * The confirmation's content: exactly what the acknowledged content removes, per category, with
 * each removed user's state. Without a diff (no baseline ids) it says so instead of a list.
 */
export function confirmParts(r: RefusalView, annotations: Record<string, PrincipalState>): ConfirmPart[] {
  const out: ConfirmPart[] = [{ kind: 'served', hash: r.hash }];
  if (!r.diff) {
    out.push({ kind: 'noDiff' });
    if (r.baseStats) out.push({ kind: 'counts', base: r.baseStats, now: r.stats });
    return out;
  }
  let any = false;
  for (const key of Object.keys(LIST_LABEL) as (keyof BundleDiff)[]) {
    const d = r.diff[key];
    if (d.removedTotal === 0) continue;
    any = true;
    out.push({
      kind: 'list',
      list: key,
      removedTotal: d.removedTotal,
      shown: d.removed.map((id) => ({ id, state: annotations[id] ?? null })),
      more: d.removedTotal > d.removed.length ? d.removedTotal - d.removed.length : 0,
    });
  }
  if (!any) out.push({ kind: 'nothingRemoved' });
  return out;
}

function englishPart(p: ConfirmPart): string {
  switch (p.kind) {
    case 'served': return `Content ${p.hash} will be served to OPA once.`;
    case 'noDiff': return 'The removed items could not be listed (the baseline holds counts only).';
    case 'counts': return `Counts: ${p.base.grants} → ${p.now.grants} grant principals, ${p.base.principals} → ${p.now.principals} governance principals, ${p.base.tables} → ${p.now.tables} tables.`;
    case 'nothingRemoved': return 'Nothing is removed.';
    case 'list': {
      const shown = p.shown.map((x) => (x.state ? `${x.id} (${STATE_LABEL[x.state]})` : x.id));
      const more = p.more > 0 ? ` … and ${p.more} more` : '';
      return `${LIST_LABEL[p.list]}: ${p.removedTotal} removed — ${shown.join(', ')}${more}`;
    }
  }
}

/** The confirmation's text in English (logs, tests): `confirmParts`, written out. */
export function confirmLines(r: RefusalView, annotations: Record<string, PrincipalState>): string[] {
  return confirmParts(r, annotations).map(englishPart);
}

/** Which failure a POST answer is — the UI picks its translated sentence from this. */
export type AckFailureCode = 'not-refused' | 'changed' | 'forbidden' | 'server' | 'http';
export function ackFailureCode(status: number, body: { error?: string; code?: string }): AckFailureCode {
  if (status === 409) return body.code === 'not-refused' ? 'not-refused' : 'changed';
  if (status === 403) return 'forbidden';
  return body.error ? 'server' : 'http';
}

/** What the card says after a failed POST. 409 → the content changed: review again (and refresh). */
export function ackFailureMessage(status: number, body: { error?: string; code?: string }): { text: string; refresh: boolean } {
  switch (ackFailureCode(status, body)) {
    case 'not-refused': return { text: 'Nothing is refused any more — the update went through on its own. The card has been refreshed.', refresh: true };
    case 'changed': return { text: 'The refused content changed since you reviewed it, so it was NOT acknowledged. The card has been refreshed — review what is removed again.', refresh: true };
    case 'forbidden': return { text: 'Not allowed: acknowledging needs the admin role and an OPA admin decision.', refresh: false };
    case 'server': return { text: body.error as string, refresh: false };
    case 'http': return { text: `Acknowledgement failed (HTTP ${status}).`, refresh: false };
  }
}

/** Catalog leaf per history kind, for `admin.policy.history.<key>` (the UI's translated HISTORY_LABEL). */
export const HISTORY_KEY = {
  refused: 'refused',
  'refusal-changed': 'refusalChanged',
  'ack-requested': 'ackRequested',
  acknowledged: 'acknowledged',
  'ack-failed': 'ackFailed',
  recovered: 'recovered',
  denied: 'denied',
} as const satisfies Record<HistoryRowView['kind'], string>;

export const HISTORY_LABEL: Record<HistoryRowView['kind'], string> = {
  refused: 'Refused',
  'refusal-changed': 'Still refused (content changed)',
  'ack-requested': 'Acknowledgement requested',
  acknowledged: 'Acknowledged',
  'ack-failed': 'Acknowledgement failed',
  recovered: 'Back in sync',
  denied: 'Access denied',
};
