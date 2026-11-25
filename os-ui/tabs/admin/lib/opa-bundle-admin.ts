/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        admin
 * FEATURE:    Platform → Policy data: see a refused os-data bundle, WHAT it would remove, acknowledge it,
 *             its history, and the alert when a refusal lasts
 * USER STORY: As an admin I want to see, without reading logs, that OPA is held on an old policy
 *             revision, exactly which users and tables the new one would remove and why each user is
 *             gone, and to accept it once with a reason that is kept in the audit trail.
 * ARCHITECTURE:
 *   - The logic behind `app/api/platform-admin/opa-bundle/route.ts` (a route cannot be imported by a
 *     test), with every effect injected: `authorize`, the bundle status/acknowledge/recompile of
 *     `core/policy/bundle.ts`, the user directory and the audit store.
 *   - GET and POST: role `admin` AND a FATAL OPA decision `authorize('user:<id>', 'admin')`.
 *   - Annotations are READ-ONLY over the existing directory: `listAccess` (the directory's `disabled`
 *     and `domains`, `accountActive`) and the recorded Access status. No new store. A directory that is not authoritative
 *     (offline seed, not loaded) annotates nothing rather than guessing.
 *   - POST acknowledges only the exact hash the admin was shown (one-shot, core/policy/bundle.ts); a
 *     different refused hash answers 409 `content-changed` so the admin reviews again. The REQUEST is
 *     audited with a CONFIRMED write BEFORE it takes effect (no trail → 503), then the outcome.
 *   - History: refusals (one row per incident, then at most one `refusal-changed` row per 10 min) and
 *     recoveries (`bundleEventRecorder`, from the bundle's event port), and acknowledgements as a
 *     confirmed `ack-requested` row then an `acknowledged` / `ack-failed` outcome row — all in the one
 *     audit store (`opa-bundle.*` actions), read back for the card.
 *   - The alert: `evaluateRefusalBell` sends one in-app notification per admin per incident once a
 *     refusal is older than `refusalAlertMinutes`, and marks them read when the incident ends. The
 *     Monitoring alert is derived from the same status (`core/policy/bundle-alert.ts`).
 *   - Logs and audit rows carry ids, hashes and counts only — never names or e-mail addresses.
 */
import { refusalAlert } from '@core/policy/bundle-alert';
import type { OsDataBundleEvent, OsDataBundleStatus } from '@core/policy/bundle';
import type { BundleDiff } from '@core/policy/bundle-guards';
import type { AuditEntry } from '@tabs/admin/lib/audit';

/** Why a removed user principal is gone, read from the directory. */
export type PrincipalState = 'deactivated' | 'disabled' | 'no-domain' | 'active' | 'unknown';

/**
 * One directory row: the directory's `disabled` and `domains`, and the Access status AS RECORDED
 * (`recordedAccessStatus`, not `listAccess().status`, which folds `disabled` into 'deactivated').
 * `active` is `accountActive` (tenant-users.ts), the one definition of an active account.
 */
export type DirectoryRow = { id: string; domains: string[]; disabled?: boolean; status?: 'active' | 'invited' | 'deactivated'; active?: boolean };

/** The least characters an acknowledgement reason must have. */
export const MIN_REASON_LENGTH = 10;

/** How many history rows the card shows. */
export const HISTORY_LIMIT = 20;

/** The audit action prefix of everything this feature records. */
export const AUDIT_PREFIX = 'opa-bundle.';

/** The user id behind a principal id: `user:<id>` → `<id>`; anything else is itself. */
export function userIdOf(principal: string): string {
  return principal.startsWith('user:') ? principal.slice('user:'.length) : principal;
}

/** The state of one user, read from the directory row (undefined row → `unknown`). */
export function principalState(row: DirectoryRow | undefined): PrincipalState {
  if (!row) return 'unknown';
  if (row.status === 'deactivated') return 'deactivated';
  if (row.disabled || row.active === false) return 'disabled';
  if (!row.domains || row.domains.length === 0) return 'no-domain';
  return 'active';
}

/**
 * The annotation of every REMOVED principal the diff names. A grant principal `user:<id>` is always
 * annotated (`unknown` when the directory does not hold it); a governance principal only when it is
 * a directory user — the others are domains and service principals, which no user state describes.
 * Null directory (not authoritative) → no annotations at all.
 */
export function annotateRemoved(diff: BundleDiff | null, directory: DirectoryRow[] | null): Record<string, PrincipalState> {
  const out: Record<string, PrincipalState> = {};
  if (!diff || !directory) return out;
  const byId = new Map(directory.map((r) => [r.id, r]));
  for (const p of diff.grantPrincipals.removed) {
    if (p.startsWith('user:')) out[p] = principalState(byId.get(userIdOf(p)));
  }
  for (const p of diff.governancePrincipals.removed) {
    const row = byId.get(userIdOf(p));
    if (row || p.startsWith('user:')) out[p] = principalState(row);
  }
  return out;
}

/** One row of the card's history. */
export type HistoryRow = {
  at: string;
  kind: 'refused' | 'refusal-changed' | 'ack-requested' | 'acknowledged' | 'ack-failed' | 'recovered' | 'denied';
  actor: string;
  hash: string;
  reason: string;
  counts: { grants?: number; principals?: number; tables?: number } | null;
  detail: string;
};

export function historyRows(entries: AuditEntry[], limit = HISTORY_LIMIT): HistoryRow[] {
  return entries
    .filter((e) => e.action.startsWith(AUDIT_PREFIX))
    .slice(0, limit)
    .map((e) => {
      const d = (e.data ?? {}) as Record<string, unknown>;
      const kind = e.action.slice(AUDIT_PREFIX.length) as HistoryRow['kind'];
      return {
        at: e.ts,
        kind,
        actor: e.actor,
        hash: typeof d.hash === 'string' ? d.hash : '',
        reason: typeof d.reason === 'string' ? d.reason : '',
        counts: d.counts && typeof d.counts === 'object' ? (d.counts as HistoryRow['counts']) : null,
        detail: e.detail,
      };
    });
}

// ------------------------------------------------------------------ handlers --

export type BundleCtx = { user: { id: string; role: string }; tenant: { id: string } };
export type Authz = { allowed: boolean; policy: string };
type AuditInput = { tenant: string; actor: string; role: string; action: string; target: string; detail: string; result?: 'ok' | 'denied' | 'error'; data?: Record<string, unknown> };

export type BundleAdminDeps = {
  authorize: (principal: string, tool: string) => Promise<Authz>;
  status: () => OsDataBundleStatus;
  acknowledge: (hash: string, by: string, reason: string) => { ok: boolean; detail: string };
  recompile: (reason: string) => Promise<{ ok: true; bundle: { revision: string } } | { ok: false; detail: string }>;
  /** The directory rows, or null when the directory is not authoritative. */
  directory: () => Promise<DirectoryRow[] | null>;
  /** The audit feed, newest first (already hydrated). */
  auditFeed: () => Promise<AuditEntry[]>;
  audit: (e: AuditInput) => void;
  /** Awaits the durable write; throws when the shared store does not confirm it. */
  auditConfirmed: (e: AuditInput) => Promise<unknown>;
};

export type HandlerResult = { status: number; body: Record<string, unknown> };

async function gate(ctx: BundleCtx, deps: BundleAdminDeps, what: string): Promise<HandlerResult | null> {
  if (ctx.user.role !== 'admin') return { status: 403, body: { error: 'forbidden', code: 'admin-only' } };
  const authz = await deps.authorize(`user:${ctx.user.id}`, 'admin');
  if (!authz.allowed) {
    deps.audit({ tenant: ctx.tenant.id, actor: ctx.user.id, role: ctx.user.role, action: `${AUDIT_PREFIX}denied`, target: 'opa:os-data', detail: `${what}: OPA ${authz.policy}`, result: 'denied' });
    return { status: 403, body: { error: 'forbidden', code: 'opa-denied', policy: authz.policy } };
  }
  return null;
}

export type BundleView = OsDataBundleStatus & {
  /** The annotation of each removed principal (`user:<id>` and directory users). */
  annotations: Record<string, PrincipalState>;
  directoryAuthoritative: boolean;
  /** The alert, when the refusal is older than the threshold. */
  alert: { title: string; detail: string } | null;
  history: HistoryRow[];
};

export async function handleBundleGet(ctx: BundleCtx, deps: BundleAdminDeps, nowMs = Date.now()): Promise<HandlerResult> {
  const denied = await gate(ctx, deps, 'read');
  if (denied) return denied;
  const status = deps.status();
  const directory = status.refused?.diff ? await deps.directory() : null;
  const view: BundleView = {
    ...status,
    annotations: annotateRemoved(status.refused?.diff ?? null, directory),
    directoryAuthoritative: directory !== null,
    alert: refusalAlert(status, nowMs),
    history: historyRows(await deps.auditFeed()),
  };
  return { status: 200, body: view };
}

export async function handleBundleAcknowledge(ctx: BundleCtx, raw: unknown, deps: BundleAdminDeps): Promise<HandlerResult> {
  const denied = await gate(ctx, deps, 'acknowledge');
  if (denied) return denied;
  const body = (raw && typeof raw === 'object' ? raw : {}) as { hash?: unknown; reason?: unknown };
  const hash = typeof body.hash === 'string' ? body.hash.trim() : '';
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!hash) return { status: 400, body: { error: 'hash is required', code: 'hash-required' } };
  if (reason.length < MIN_REASON_LENGTH) return { status: 400, body: { error: `a reason of at least ${MIN_REASON_LENGTH} characters is required`, code: 'reason-too-short' } };
  const refused = deps.status().refused;
  if (!refused || refused.hash !== hash) {
    return {
      status: 409,
      body: {
        error: refused ? 'the refused content has changed since you reviewed it — review it again' : 'nothing is refused any more',
        code: refused ? 'content-changed' : 'not-refused',
        current: refused?.hash ?? null,
      },
    };
  }
  const counts = { grants: refused.stats.grants, principals: refused.stats.principals, tables: refused.stats.tables };
  const removed = refused.diff
    ? { grantPrincipals: refused.diff.grantPrincipals.removedTotal, governancePrincipals: refused.diff.governancePrincipals.removedTotal, tables: refused.diff.tables.removedTotal }
    : null;
  const data = { hash, reason, counts, baseCounts: refused.baseStats, removed, reasons: refused.reasons, refusedSince: refused.since };
  const row = { tenant: ctx.tenant.id, actor: ctx.user.id, role: ctx.user.role, target: 'opa:os-data' };
  // 1) The REQUEST, durably, before any effect: no trail → no acknowledgement.
  try {
    await deps.auditConfirmed({ ...row, action: `${AUDIT_PREFIX}ack-requested`, detail: `acknowledgement requested for refused content ${hash} — ${refused.reasons.join('; ')}`, data });
  } catch (err) {
    return { status: 503, body: { error: `not acknowledged: ${err instanceof Error ? err.message : String(err)}`, code: 'audit-unavailable' } };
  }
  // 2) The effect, re-checked against the refused content NOW (a resync may have changed it during the write).
  const ack = deps.acknowledge(hash, ctx.user.id, reason);
  // 3) The OUTCOME, so the trail never claims an acknowledgement that did not happen.
  if (!ack.ok) {
    deps.audit({ ...row, action: `${AUDIT_PREFIX}ack-failed`, detail: `not acknowledged: ${ack.detail}`, result: 'error', data: { ...data, failure: ack.detail } });
    return { status: 409, body: { error: 'the refused content has changed since you reviewed it — review it again', code: 'content-changed', detail: ack.detail } };
  }
  deps.audit({ ...row, action: `${AUDIT_PREFIX}acknowledged`, detail: `acknowledged refused content ${hash} — ${refused.reasons.join('; ')}`, data });
  const r = await deps.recompile('admin-acknowledged');
  return { status: 200, body: { acknowledged: true, compiled: r.ok, detail: r.ok ? r.bundle.revision : r.detail } };
}

// ------------------------------------------------------------------ history + alert --

/** At most one `refusal-changed` row per this interval within one incident. */
export const REFUSAL_CHANGE_ROW_MS = 10 * 60_000;

/**
 * The audit recorder of the bundle's event port, BOUNDED so a store that keeps shifting cannot
 * flood the history: one `refused` row when an incident starts, then a `refusal-changed` row for
 * newer refused content at most every `changeIntervalMs` (rows skipped meanwhile are counted into
 * the next row), and one `recovered` row when it ends.
 */
export function bundleEventRecorder(tenant: string, write: (e: AuditInput) => void, opts: { changeIntervalMs?: number; now?: () => number } = {}): (e: OsDataBundleEvent) => void {
  const every = opts.changeIntervalMs ?? REFUSAL_CHANGE_ROW_MS;
  const now = opts.now ?? Date.now;
  let incident: { since: string; lastRowMs: number; skipped: number } | null = null;
  return (e) => {
    if (e.kind === 'refused') {
      const r = e.refusal;
      const data = {
        hash: r.hash, counts: r.stats, baseCounts: r.baseStats, reasons: r.reasons, since: r.since,
        removed: r.diff ? { grantPrincipals: r.diff.grantPrincipals.removedTotal, governancePrincipals: r.diff.governancePrincipals.removedTotal, tables: r.diff.tables.removedTotal } : null,
      };
      if (!incident || incident.since !== r.since) {
        incident = { since: r.since, lastRowMs: now(), skipped: 0 };
        write({ tenant, actor: 'system', role: 'system', action: `${AUDIT_PREFIX}refused`, target: 'opa:os-data', detail: `refused content ${r.hash} — ${r.reasons.join('; ')}`, result: 'denied', data });
        return;
      }
      if (now() - incident.lastRowMs < every) {
        incident.skipped += 1;
        return;
      }
      const skipped = incident.skipped;
      incident.lastRowMs = now();
      incident.skipped = 0;
      write({
        tenant, actor: 'system', role: 'system', action: `${AUDIT_PREFIX}refusal-changed`, target: 'opa:os-data',
        detail: `still refused, now content ${r.hash}${skipped ? ` (${skipped} other refused content(s) since the last row)` : ''} — ${r.reasons.join('; ')}`,
        result: 'denied', data: { ...data, skipped },
      });
      return;
    }
    const skipped = incident?.skipped ?? 0;
    incident = null;
    write({
      tenant, actor: 'system', role: 'system', action: `${AUDIT_PREFIX}recovered`, target: 'opa:os-data',
      detail: `compile passed (revision ${e.revision})${e.acknowledged ? ' with an admin acknowledgement' : ''}; refused since ${e.refusedSince}${skipped ? `; ${skipped} refused content(s) not recorded separately` : ''}`,
      data: { hash: e.refusedHash, revision: e.revision, since: e.refusedSince, acknowledged: e.acknowledged, skipped },
    });
  };
}

/** The bell's memory of the current incident: which notification each admin got. */
export type BellIncident = { since: string; sent: { userId: string; id: string }[] } | null;

export type BellDeps = {
  status: () => OsDataBundleStatus;
  /** The ids of the active admins. */
  admins: () => Promise<string[]>;
  notify: (n: { userId: string; kind: 'alert'; title: string; body: string }) => { id: string };
  markRead: (userId: string, ids: string[]) => void;
  nowMs?: number;
};

/**
 * One evaluation: raise the in-app alert to every admin once per incident after the threshold,
 * mark it read when the refusal ends. Returns the incident memory for the next evaluation.
 */
export async function evaluateRefusalBell(incident: BellIncident, deps: BellDeps): Promise<BellIncident> {
  const status = deps.status();
  const alert = refusalAlert(status, deps.nowMs ?? Date.now());
  if (!status.refused) {
    if (incident) for (const s of incident.sent) deps.markRead(s.userId, [s.id]);
    return null;
  }
  if (incident && incident.since !== status.refused.since) {
    for (const s of incident.sent) deps.markRead(s.userId, [s.id]);
    incident = null;
  }
  if (!alert || incident) return incident;
  const sent: { userId: string; id: string }[] = [];
  for (const userId of await deps.admins()) {
    const n = deps.notify({ userId, kind: 'alert', title: alert.title, body: `${alert.detail}\nReview it in Platform → Policy data.` });
    sent.push({ userId, id: n.id });
  }
  // No admin found (a directory not loaded yet): nothing was raised, so try again next time.
  return sent.length ? { since: status.refused.since, sent } : null;
}
