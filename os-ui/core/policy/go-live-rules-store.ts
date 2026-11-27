/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       kernel policy
 * FEATURE:    App Builder (F) - the durable, sealed store of the global go-live rule table (Platform → Go-live rules)
 * USER STORY: As an admin I change who must review going live in Prod per kind and scope, and I want that change to
 *             hold across restarts and pods, to be audited with the old and the new table, and to be impossible to
 *             forge by writing to the search index directly. As anyone going live I want a broken or unreadable table
 *             to mean "an admin reviews", never "nobody reviews".
 * ARCHITECTURE:
 *   - ONE document (`table`) in the OpenSearch index `os-go-live-rules` through the shared durable-mirror core
 *     (core/infra/os-mirror.ts), like role-config.ts. Read on EVERY decision (no process cache): a go-live is rare,
 *     and a cache would let one pod keep a table another pod's admin already changed.
 *   - INTEGRITY: the document carries an HMAC-SHA256 seal over its canonical form, keyed by a purpose-bound key
 *     derived from `config.sessionSecret` (the same secret that signs sessions and the domain-delete confirmation).
 *     Someone who can write the index but does not hold the os-ui secret cannot produce a table the OS accepts.
 *   - FAIL CLOSED, in the safe direction only:
 *       absent document         → the defaults of spec section 9 (`DEFAULT_GO_LIVE_RULES`), integrity `default`;
 *       sealed and valid        → the stored table, integrity `sealed`;
 *       seal or shape wrong     → EVERY row `admin` (integrity `broken`) until an admin saves the table again;
 *       store unreachable       → EVERY row `admin` (integrity `unreachable`), re-read on the next decision.
 *     A rotated session secret therefore reads as `broken` (all rows admin) until an admin re-saves: stated in the UI.
 *   - VALIDATION (`validateGoLiveRules`): rows are exactly `{ kind, scope, reviewer }` from the closed sets in
 *     go-live-rules.ts; any other field (for example an attempt at `selfApproval`) is refused, so no row can ever
 *     allow self-approval — that invariant lives in `canReview` and has no setting. Duplicate rows are refused. Input
 *     rows are MERGED onto the table in force, so the result always has every (kind, scope) row.
 *   - WRITE (`setGoLiveRules`): admin only (re-checked here; the doors also check the role and OPA), optimistic
 *     `expectedVersion`, confirmed write (`writeConfirmed`) before anything is reported, then one audit row
 *     (`policy.override`, subject `go-live-rules`) with the old and the new table and the OPA decision it rode on.
 *   - The rules decide WHO reviews; they never skip a gate. Kernel module: imports only @core.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '@core/kernel/config';
import { osMirror, type MirrorRead } from '@core/infra/os-mirror';
import { record as audit } from '@core/policy/audit';
import {
  DEFAULT_GO_LIVE_RULES,
  GO_LIVE_KINDS,
  GO_LIVE_SCOPES,
  REVIEWERS,
  type GoLiveKind,
  type GoLiveRule,
  type GoLiveScope,
  type Reviewer,
} from '@core/policy/go-live-rules';

export type GoLiveRulesIntegrity = 'sealed' | 'default' | 'broken' | 'unreachable';

export type GoLiveRulesState = {
  rules: GoLiveRule[];
  /** 0 = never saved (defaults); every save adds one. */
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  integrity: GoLiveRulesIntegrity;
  /** Why the table in force is not the stored one (broken / unreachable). */
  reason?: string;
};

/** The minimum of the durable mirror this store uses (a seam for tests). */
export type GoLiveRulesMirror = {
  probe(): Promise<boolean>;
  read(id: string): Promise<MirrorRead>;
  writeConfirmed(id: string, doc: unknown): Promise<{ ok: true } | { ok: false; reason: string }>;
};

const DOC_ID = 'table';
const SEAL_PURPOSE = 'sovereign-os/go-live-rules/v1';
const ROW_KEYS = ['kind', 'scope', 'reviewer'] as const;

type StoredDoc = {
  id: typeof DOC_ID;
  v: 1;
  version: number;
  rules: GoLiveRule[];
  updatedAt: string;
  updatedBy: string;
  seal: string;
};

function statusError(message: string, status: number): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

const MIRROR_KEY = Symbol.for('soa.policy.go-live-rules.mirror');
function mirror(): GoLiveRulesMirror {
  const g = globalThis as unknown as Record<symbol, GoLiveRulesMirror | undefined>;
  if (!g[MIRROR_KEY]) g[MIRROR_KEY] = osMirror({ index: 'os-go-live-rules', createBody: { mappings: { dynamic: false } } });
  return g[MIRROR_KEY]!;
}

/** Test-only: replace the durable mirror (null restores the real one). */
export function __setGoLiveRulesMirror(m: GoLiveRulesMirror | null): void {
  const g = globalThis as unknown as Record<symbol, GoLiveRulesMirror | undefined>;
  g[MIRROR_KEY] = m ?? undefined;
}

/** The table a broken or unreadable store yields: every row needs an admin. */
export function failClosedRules(): GoLiveRule[] {
  return GO_LIVE_KINDS.flatMap((kind) => GO_LIVE_SCOPES.map((scope) => ({ kind, scope, reviewer: 'admin' as Reviewer })));
}

function defaults(): GoLiveRule[] {
  return DEFAULT_GO_LIVE_RULES.map((r) => ({ ...r }));
}

/** Rows in the fixed (kind, scope) order, so the seal and the audit diff never depend on input order. */
function ordered(rules: readonly GoLiveRule[]): GoLiveRule[] {
  const rank = (r: GoLiveRule) => GO_LIVE_KINDS.indexOf(r.kind) * GO_LIVE_SCOPES.length + GO_LIVE_SCOPES.indexOf(r.scope);
  return [...rules].map((r) => ({ kind: r.kind, scope: r.scope, reviewer: r.reviewer })).sort((a, b) => rank(a) - rank(b));
}

function sealOf(d: { version: number; rules: readonly GoLiveRule[]; updatedAt: string; updatedBy: string }): string {
  const key = createHmac('sha256', config.sessionSecret).update(SEAL_PURPOSE).digest();
  const canonical = JSON.stringify({ v: 1, version: d.version, rules: ordered(d.rules), updatedAt: d.updatedAt, updatedBy: d.updatedBy });
  return createHmac('sha256', key).update(canonical).digest('base64url');
}

function sealMatches(expected: string, got: unknown): boolean {
  if (typeof got !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type GoLiveRulesValidation = { ok: true; rules: GoLiveRule[] } | { ok: false; reason: string };

/**
 * Validate rows and merge them onto `base` (the table in force). Each row must be exactly `{ kind, scope, reviewer }`
 * from the closed sets; anything else is refused with the row it was found in. Self-approval cannot be expressed.
 */
export function validateGoLiveRules(input: unknown, base: readonly GoLiveRule[] = DEFAULT_GO_LIVE_RULES): GoLiveRulesValidation {
  if (!Array.isArray(input) || input.length === 0) return { ok: false, reason: '`rules` must be a non-empty list of { kind, scope, reviewer }' };
  const seen = new Set<string>();
  const parsed: GoLiveRule[] = [];
  for (const [i, raw] of input.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: `rule ${i + 1} is not an object` };
    const row = raw as Record<string, unknown>;
    const extra = Object.keys(row).filter((k) => !(ROW_KEYS as readonly string[]).includes(k));
    if (extra.length > 0) {
      return {
        ok: false,
        reason: `rule ${i + 1} has unknown field(s) ${extra.map((k) => `'${k}'`).join(', ')}; a rule is only { kind, scope, reviewer }, and nobody approving their own go-live is not configurable`,
      };
    }
    const { kind, scope, reviewer } = row;
    if (!(GO_LIVE_KINDS as readonly unknown[]).includes(kind)) return { ok: false, reason: `rule ${i + 1}: kind must be one of ${GO_LIVE_KINDS.join(', ')}` };
    if (!(GO_LIVE_SCOPES as readonly unknown[]).includes(scope)) return { ok: false, reason: `rule ${i + 1}: scope must be one of ${GO_LIVE_SCOPES.join(', ')}` };
    if (!(REVIEWERS as readonly unknown[]).includes(reviewer)) return { ok: false, reason: `rule ${i + 1}: reviewer must be one of ${REVIEWERS.join(', ')}` };
    const k = `${kind}/${scope}`;
    if (seen.has(k)) return { ok: false, reason: `rule ${i + 1}: there is already a rule for ${kind} in ${scope} scope` };
    seen.add(k);
    parsed.push({ kind: kind as GoLiveKind, scope: scope as GoLiveScope, reviewer: reviewer as Reviewer });
  }
  const merged = new Map<string, GoLiveRule>();
  for (const r of base) merged.set(`${r.kind}/${r.scope}`, { ...r });
  for (const r of parsed) merged.set(`${r.kind}/${r.scope}`, r);
  // Complete: a row missing from `base` too is an admin review (the decision fails closed the same way).
  for (const kind of GO_LIVE_KINDS) {
    for (const scope of GO_LIVE_SCOPES) {
      if (!merged.has(`${kind}/${scope}`)) merged.set(`${kind}/${scope}`, { kind, scope, reviewer: 'admin' });
    }
  }
  return { ok: true, rules: ordered([...merged.values()]) };
}

/** A stored document is accepted only when its seal matches AND every row is valid and complete. */
function acceptStored(doc: unknown): { ok: true; state: GoLiveRulesState } | { ok: false; reason: string } {
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'the stored go-live rule table is not a document' };
  const d = doc as Partial<StoredDoc>;
  if (d.v !== 1 || typeof d.version !== 'number' || !Number.isInteger(d.version) || d.version < 1 || typeof d.updatedAt !== 'string' || typeof d.updatedBy !== 'string' || !Array.isArray(d.rules)) {
    return { ok: false, reason: 'the stored go-live rule table has an unknown shape' };
  }
  const v = validateGoLiveRules(d.rules, []);
  if (!v.ok) return { ok: false, reason: `the stored go-live rule table is invalid: ${v.reason}` };
  if (v.rules.length !== d.rules.length) return { ok: false, reason: 'the stored go-live rule table is incomplete' };
  if (!sealMatches(sealOf({ version: d.version, rules: d.rules as GoLiveRule[], updatedAt: d.updatedAt, updatedBy: d.updatedBy }), d.seal)) {
    return { ok: false, reason: 'the stored go-live rule table does not carry a valid seal (changed outside the OS, or the session secret was rotated); an admin must save it again' };
  }
  return { ok: true, state: { rules: v.rules, version: d.version, updatedAt: d.updatedAt, updatedBy: d.updatedBy, integrity: 'sealed' } };
}

/** The table in force right now (see the fail-closed table in the header). Never throws. */
export async function readGoLiveRules(): Promise<GoLiveRulesState> {
  const m = mirror();
  let r: MirrorRead;
  try {
    r = (await m.probe()) ? await m.read(DOC_ID) : { state: 'unreachable' };
  } catch {
    r = { state: 'unreachable' };
  }
  if (r.state === 'absent') return { rules: defaults(), version: 0, updatedAt: null, updatedBy: null, integrity: 'default' };
  if (r.state === 'unreachable') {
    return {
      rules: failClosedRules(),
      version: 0,
      updatedAt: null,
      updatedBy: null,
      integrity: 'unreachable',
      reason: 'the go-live rule store could not be read, so every go-live needs an admin until it answers',
    };
  }
  const accepted = acceptStored(r.doc);
  if (accepted.ok) return accepted.state;
  const d = (r.doc ?? {}) as Partial<StoredDoc>;
  return {
    rules: failClosedRules(),
    version: typeof d.version === 'number' ? d.version : 0,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : null,
    updatedBy: typeof d.updatedBy === 'string' ? d.updatedBy : null,
    integrity: 'broken',
    reason: `${accepted.reason}; every go-live needs an admin until then`,
  };
}

export type SetGoLiveRulesInput = {
  rules: unknown;
  /** The version the editor saw; a different version in force ⇒ 409 (someone else saved in between). */
  expectedVersion?: unknown;
  actor: { id: string; role: string };
  /** The OPA decision the door rode on, for the audit row. */
  opa?: { decisionId?: string; policyRev?: string };
  /** Where the change came from, for the audit row. */
  via: 'ui' | 'mcp';
};

/**
 * Save rows (merged onto the table in force), sealed, confirmed durable, then audited with old and new. Admin only.
 * Throws with `status` 400 (invalid), 403 (not admin), 409 (version moved), 503 (store did not confirm).
 */
export async function setGoLiveRules(input: SetGoLiveRulesInput): Promise<GoLiveRulesState & { previous: GoLiveRule[] }> {
  if (input.actor.role !== 'admin') throw statusError('only an admin can change the go-live rules', 403);
  const current = await readGoLiveRules();
  if (current.integrity === 'unreachable') throw statusError(current.reason ?? 'the go-live rule store could not be read', 503);
  if (input.expectedVersion !== undefined && input.expectedVersion !== null && input.expectedVersion !== current.version) {
    throw statusError(`the go-live rules changed since you opened them (now version ${current.version}); reload and try again`, 409);
  }
  // A broken table merges onto the DEFAULTS, not onto the fail-closed all-admin view, so re-saving it restores a
  // sealed table the admin actually sees in the editor (the editor shows the rows it sends in full anyway).
  const base = current.integrity === 'broken' ? defaults() : current.rules;
  const v = validateGoLiveRules(input.rules, base);
  if (!v.ok) throw statusError(v.reason, 400);

  const version = current.version + 1;
  const updatedAt = new Date().toISOString();
  const doc: StoredDoc = { id: DOC_ID, v: 1, version, rules: v.rules, updatedAt, updatedBy: input.actor.id, seal: '' };
  doc.seal = sealOf(doc);
  const w = await mirror().writeConfirmed(DOC_ID, doc);
  if (!w.ok) throw statusError(`the go-live rules were not changed: the store did not confirm the write (${w.reason})`, 503);

  const previous = current.rules;
  const changed = v.rules
    .filter((r) => previous.find((p) => p.kind === r.kind && p.scope === r.scope)?.reviewer !== r.reviewer)
    .map((r) => `${r.kind}/${r.scope}: ${previous.find((p) => p.kind === r.kind && p.scope === r.scope)?.reviewer ?? 'admin'} → ${r.reviewer}`);
  audit({
    actor: input.actor.id,
    action: 'policy.override',
    subject: 'go-live-rules',
    domain: '*',
    reason: changed.length > 0 ? `go-live rules v${version} (${input.via}): ${changed.join('; ')}` : `go-live rules v${version} (${input.via}): saved without changes`,
    detail: { table: 'go-live-rules', version, previousVersion: current.version, previousIntegrity: current.integrity, old: previous, new: v.rules, via: input.via },
    ...(input.opa?.decisionId ? { decisionId: input.opa.decisionId } : {}),
    ...(input.opa?.policyRev ? { policyRev: input.opa.policyRev } : {}),
  });
  return { rules: v.rules, version, updatedAt, updatedBy: input.actor.id, integrity: 'sealed', previous };
}
