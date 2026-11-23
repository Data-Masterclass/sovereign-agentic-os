/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The continuous key reconcile: on a timer, compare every agent system's model key at
 *             the gateway with what its definition says, and report a difference as drift.
 *
 * USER STORY: As a platform admin I change a system's key in LiteLLM (a bigger budget, one more
 *             model) and the OS shows it within minutes as drift — it neither hides it nor undoes it
 *             behind my back. If I want a system's key kept exactly as its definition says, I switch
 *             auto-correct on for that system.
 *             As a system owner, a key someone deleted at the gateway shows up as an alert on my
 *             system, not as a failed scheduled run.
 *
 * ARCHITECTURE:
 *   - OWNERSHIP (one owner per object): LiteLLM owns providers, credentials, models, global budgets
 *     and teams; the OS owns the per-system virtual key — its models, budget, limits and
 *     `allowed_tools`, all derived from the system's grants. The platform team works directly in
 *     LiteLLM, so the OS cannot assume its key is untouched; it LOOKS, on a timer.
 *   - ONE COMPARISON. "Wanted" is `keyWanted` and the difference is `keyDrift` (both in `live.ts`),
 *     the very pair the Build's `litellm` step writes and verifies with. The gateway is read with the
 *     Build's own client (`keysByAlias` → `/key/list?key_alias=…&return_full_object=true`).
 *   - ALERT FIRST. A difference is recorded in the report (`core/infra/agent-key-drift.ts`), which
 *     Admin → Gateway and Monitoring → Agents read. Nothing at the gateway is written unless the
 *     system is in the `autoCorrect` set (an admin's per-system choice, chart value
 *     `osUI.agentSystemKey.reconcile.autoCorrectSystems`). Correcting runs the Build's `litellm` step
 *     (`reapplySystemKeyWith`) — the same code as a Rebuild — and is audited (`gateway.key.reconcile`).
 *     ONE exception, also audited: a key whose only difference is an allowed-tools list stamped by an
 *     earlier OS release (`staleToolsStamp`, `ALLOWED_TOOLS_REV` in `run-tools.ts`) is re-stamped for
 *     every system — the OS changed what a run offers, nobody edited the key, and left alone every
 *     run of the system is refused by the gateway.
 *   - A MISSING VALUE IS DRIFT where it matters: a key whose `allowed_tools` metadata was dropped, a
 *     key the gateway no longer holds, a second key under the alias. A gateway that cannot be read is
 *     "could not check" (`ok: false`, nothing counted as in sync), never "no drift".
 *   - NOT DRIFT: a system nobody has built (no stored key, no gateway key); a replacement still
 *     completing (the journal holds it); keys moved aside by a replacement (other aliases).
 *   - os-ui web only: it needs the gateway's admin API (the master key), which the worker lacks.
 *   - The timer is `scheduleEvery` (`core/reconcile/runtime.ts`); the first pass is one interval
 *     after boot, so a key migration at boot has finished before the first comparison.
 */
import 'server-only';
import { scheduleEvery } from '@core/reconcile/runtime';
import { record as audit } from '@core/policy/audit';
import { config } from '@core/kernel/config';
import { liteLlmConfigured } from '@core/infra/litellm-admin';
import { systemKeyAlias, tryOpenSystemKey } from '@core/infra/agent-system-keys';
import { lastKeyReconcile, setKeyReconcile, type KeyDriftEntry, type KeyDriftKind, type KeyReconcileReport } from '@core/infra/agent-key-drift';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import { compile } from '@tabs/agents/lib/langgraph-compile';
import { orchestrateBuild } from '@tabs/agents/lib/build/orchestrate';
import { keyDrift, keyWanted, makeLiveAdapters, type LiveDeps } from '@tabs/agents/lib/build/live';
import type { MigrationSystem } from '@tabs/agents/lib/build/system-key-migration';
import { ALLOWED_TOOLS_REV } from '@tabs/agents/lib/build/run-tools';
import { onSystemChange } from '@tabs/agents/lib/system-events';

/** The systems whose drift is put back automatically: a set of ids, or every system. */
export type AutoCorrect = ReadonlySet<string> | 'all';

/** `"sys_a, sys_b"` → those ids; `"*"` → all; empty → none (the default: alert only). */
export function parseAutoCorrect(raw: string | undefined): AutoCorrect {
  const parts = (raw ?? '').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.includes('*')) return 'all';
  return new Set(parts.filter((p) => /^[A-Za-z0-9_.:-]{1,128}$/.test(p)));
}

export type KeyReconcileIo = {
  /** The existing systems, or null when the registry cannot be trusted (not hydrated). */
  systems: () => Promise<MigrationSystem[] | null>;
  /** The definition the Build would use for this owner (grants governed for them). */
  governYaml: (yaml: string, owner: string) => Promise<string>;
  deps: LiveDeps;
  autoCorrect: AutoCorrect;
  /** The previous report, so a standing drift keeps its first-seen time. Defaults to the process's last. */
  previous?: KeyReconcileReport | null;
  now?: () => number;
  log?: (line: string) => void;
  audit?: typeof audit;
};

/** The Build's `litellm` step alone, WITHOUT a rotation: the key keeps its value, its properties are re-asserted. */
export async function reapplySystemKeyWith(systemId: string, yaml: string, deps: LiveDeps): Promise<{ ok: boolean; detail: string; error?: string }> {
  const adapters = makeLiveAdapters(deps).filter((a) => a.tool === 'litellm');
  const report = await orchestrateBuild({ yaml, systemId, adapters, probe: 'Key reconcile' });
  const row = report.rows.find((r) => r.tool === 'litellm') ?? report.rows[0];
  return report.ok && row?.tool === 'litellm'
    ? { ok: true, detail: row.appliedDetail ?? row.detail }
    : { ok: false, detail: '', error: row?.error ?? 'the key was not re-applied' };
}

/**
 * An admin's "re-apply from the OS" for one system: `reapplySystemKeyWith`, then ONE audit entry
 * (who, which key, what had drifted, the outcome) — the entry is written whether or not it worked.
 * The caller has already checked that the actor is an admin.
 */
export async function reapplyAudited(input: {
  systemId: string;
  yaml: string;
  domain: string;
  actor: string;
  deps: LiveDeps;
  /** The drift the report showed for this system, recorded in the audit entry. */
  drift?: Pick<KeyDriftEntry, 'kind' | 'changes'>;
  audit?: typeof audit;
}): Promise<{ ok: boolean; detail: string; error?: string }> {
  const out = await reapplySystemKeyWith(input.systemId, input.yaml, input.deps).catch((e: Error) => ({ ok: false, detail: '', error: e.message }));
  (input.audit ?? audit)({
    actor: input.actor,
    action: 'gateway.key.reapply',
    subject: systemKeyAlias(input.systemId),
    domain: input.domain,
    reason: out.ok ? 'an admin re-applied the system\'s key from its definition (the key value was not changed)' : `an admin tried to re-apply the system\'s key and it failed: ${out.error}`,
    detail: { outcome: out.ok ? 'reapplied' : 'failed', ...(input.drift ? { kind: input.drift.kind, changes: input.drift.changes } : {}) },
  });
  return out;
}

/**
 * `staleStamp`: the ONLY difference is the allowed tools and/or the models, and the key was stamped by an earlier
 * OS release (`os_allowed_tools_rev` older than `ALLOWED_TOOLS_REV`, or absent while the list is
 * present). Nobody edited it: the OS changed what a run offers. Such a key is re-stamped whether or not
 * auto-correct is on for the system — left alone, every run of the system is refused by the gateway
 * (`tool_access_denied`). A key whose metadata a person replaced (list missing), or whose budget,
 * models or limits also differ, stays an alert.
 */
type Verdict = { kind: KeyDriftKind; changes: string[]; staleStamp?: boolean } | 'in-sync' | 'not-built' | 'in-flight';

/**
 * True when the drift is only what the OS DERIVES for the key — the allowed-tools list and, since revision 4, the
 * models (the roles the agents run on) — and the key was stamped by an earlier OS release.
 */
export function staleToolsStamp(have: { allowedTools?: string[]; allowedToolsRev?: number }, changes: string[]): boolean {
  if (have.allowedTools === undefined || changes.length === 0) return false;
  if (!changes.every((c) => c.startsWith('allowed tools ') || c.startsWith('models '))) return false;
  return (have.allowedToolsRev ?? 1) < ALLOWED_TOOLS_REV;
}

/** How one system's key at the gateway compares with its definition. Throws if the gateway cannot be read. */
async function judge(s: MigrationSystem, yaml: string, deps: LiveDeps): Promise<Verdict> {
  const alias = systemKeyAlias(s.id);
  if (await deps.keys.journal.staged(s.id)) return 'in-flight';
  const record = await deps.keys.store.get(s.id);
  const atGateway = await deps.litellm.keysByAlias(alias);
  if (!record && atGateway.length === 0) return 'not-built';
  if (atGateway.length === 0) return { kind: 'missing', changes: ['the gateway no longer holds this system\'s key (deleted there); a re-apply issues a new one'] };
  if (atGateway.length > 1) return { kind: 'duplicate', changes: [`the gateway holds ${atGateway.length} keys under '${alias}'; exactly one is expected`] };
  const have = atGateway[0];
  const stored = record ? tryOpenSystemKey(record, deps.keys.kek()) : null;
  if (!record || !stored?.ok || record.tokenId !== have.tokenId) {
    return { kind: 'not-ours', changes: ['the key at the gateway is not the one the OS stored for this system (or the stored copy cannot be read)'] };
  }
  const system = parseSystem(yaml);
  const want = await keyWanted(deps)({ system, ir: compile(system), systemId: s.id });
  const changes = keyDrift(have, want);
  return changes.length === 0 ? 'in-sync' : { kind: 'drift', changes, ...(staleToolsStamp(have, changes) ? { staleStamp: true } : {}) };
}

/** One pass over injected IO. Every system is judged independently; failures come back as data. */
export async function runKeyReconcile(io: KeyReconcileIo): Promise<KeyReconcileReport> {
  const now = io.now ?? Date.now;
  const log = io.log ?? ((line: string) => console.info(`[key-reconcile] ${line}`));
  const write = io.audit ?? audit;
  const at = now();
  const previous = io.previous === undefined ? lastKeyReconcile() : io.previous;
  const finish = (r: KeyReconcileReport): KeyReconcileReport => {
    setKeyReconcile(r);
    return r;
  };
  const systems = await io.systems();
  if (systems === null) {
    log('the agent registry has not hydrated from the mirror yet — nothing compared');
    return finish({ at, ok: false, scanned: 0, inSync: 0, notBuilt: 0, inFlight: 0, entries: [], unchecked: [], error: 'registry not hydrated' });
  }
  const report: KeyReconcileReport = { at, ok: true, scanned: systems.length, inSync: 0, notBuilt: 0, inFlight: 0, entries: [], unchecked: [] };
  for (const s of systems) {
    const alias = systemKeyAlias(s.id);
    let yaml: string;
    let verdict: Verdict;
    try {
      yaml = await io.governYaml(s.yaml, s.owner);
      verdict = await judge(s, yaml, io.deps);
    } catch (e) {
      report.ok = false;
      report.unchecked.push({ systemId: s.id, error: (e as Error)?.message ?? String(e) });
      continue;
    }
    if (verdict === 'in-sync') report.inSync += 1;
    else if (verdict === 'not-built') report.notBuilt += 1;
    else if (verdict === 'in-flight') report.inFlight += 1;
    else {
      const firstSeenAt = previous?.entries.find((p) => p.systemId === s.id && p.kind === verdict.kind)?.firstSeenAt ?? at;
      const entry: KeyDriftEntry = { systemId: s.id, alias, kind: verdict.kind, changes: verdict.changes, firstSeenAt, action: 'alert' };
      if (verdict.staleStamp || io.autoCorrect === 'all' || io.autoCorrect.has(s.id)) {
        const fixed = await reapplySystemKeyWith(s.id, yaml, io.deps).catch((e: Error) => ({ ok: false, detail: '', error: e.message }));
        entry.action = fixed.ok ? 'corrected' : 'correction-failed';
        if (!fixed.ok) entry.error = fixed.error;
        write({
          actor: 'system:os-ui',
          action: 'gateway.key.reconcile',
          subject: alias,
          domain: s.domain,
          reason: verdict.staleStamp
            ? fixed.ok
              ? `the key's tools/models were stamped by an earlier OS release; re-stamped from the definition (${verdict.changes.join('; ')})`
              : `the key's tools/models were stamped by an earlier OS release and could not be re-stamped: ${fixed.error}`
            : fixed.ok ? `auto-correct is on for this system: its key was put back to its definition (${verdict.changes.join('; ')})` : `auto-correct is on for this system but the key could not be corrected: ${fixed.error}`,
          detail: { outcome: entry.action, kind: verdict.kind, changes: verdict.changes, ...(verdict.staleStamp ? { cause: 'stale-allowed-tools-stamp' } : {}) },
        });
        log(`${fixed.ok ? 'corrected' : 'could NOT correct'} '${alias}': ${verdict.changes.join('; ')}`);
      } else {
        log(`drift on '${alias}' (${verdict.kind}): ${verdict.changes.join('; ')}`);
      }
      report.entries.push(entry);
    }
  }
  log(`pass done — ${report.scanned} system(s): ${report.inSync} in sync, ${report.entries.length} drifted, ${report.notBuilt} not built, ${report.unchecked.length} unreadable`);
  return finish(report);
}

/**
 * At boot of os-ui web: start the timer. Boot never waits for it; a failed pass is logged by
 * `scheduleEvery`, never thrown into boot. Off when the gateway is not configured here or the
 * interval is 0.
 */
export function scheduleKeyReconcile(pass: () => Promise<unknown>, intervalSeconds: number = config.agentKeyReconcile.intervalSeconds): (() => void) | null {
  const g = globalThis as unknown as { __osKeyReconcileBooted?: boolean };
  if (g.__osKeyReconcileBooted || !liteLlmConfigured() || intervalSeconds <= 0) return null;
  g.__osKeyReconcileBooted = true;
  return scheduleEvery('agent-key-reconcile', intervalSeconds * 1000, pass);
}

/** The real wiring: this registry, this gateway, this store, the chart's auto-correct choice. */
export async function reconcileKeysLive(): Promise<KeyReconcileReport> {
  const [{ ensureHydrated, listSystemsForKeyMigration }, { governYamlForOwner }, { makeRealClients }] = await Promise.all([
    import('@tabs/agents/lib/store'),
    import('@tabs/agents/lib/build/owner-grants'),
    import('@tabs/agents/lib/build/live-clients'),
  ]);
  return runKeyReconcile({
    systems: async () => {
      await ensureHydrated();
      return listSystemsForKeyMigration();
    },
    governYaml: governYamlForOwner,
    deps: makeRealClients(),
    autoCorrect: parseAutoCorrect(config.agentKeyReconcile.autoCorrectSystems),
  });
}

// ------------------------------------------------------------ OS-derived fields: on save and before every run

/**
 * Why the key was re-stamped: a definition was saved (`save-sync`), or a run is about to start (`pre-run-sync`).
 * Owner decision (23 Nov 2026): the system key must never be the reason a run fails.
 */
export type KeySyncCause = 'save-sync' | 'pre-run-sync';
export type KeySyncOutcome =
  | { state: 'in-sync' | 'not-built' | 'in-flight' | 'not-ours'; changes: string[] }
  | { state: 'synced'; changes: string[] }
  | { state: 'unreachable'; changes: string[]; error: string };

/** A key's OS-derived fields after a sync: exactly the definition, or the definition added to what the key has. */
function derivedTarget(have: { models: string[]; allowedTools?: string[] }, want: { models: string[]; allowedTools: string[] }, narrow: boolean): { models: string[]; allowedTools: string[] } {
  if (narrow) return { models: [...want.models].sort(), allowedTools: [...want.allowedTools].sort() };
  return {
    models: [...new Set([...have.models, ...want.models])].sort(),
    allowedTools: [...new Set([...(have.allowedTools ?? []), ...want.allowedTools])].sort(),
  };
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * Bring the system key's OS-DERIVED fields — `allowed_tools` (what a run offers) and `models` (the roles its agents run
 * on) — to what the definition says, and ONLY those: one `/key/update` with `models` and the metadata MERGED (the
 * allowed tools and the OS stamp replaced, every other metadata key kept); the key's value, budget, limits and per-model
 * budget are not sent, so they stay exactly as they are. One gateway read; a write only when they differ, then ONE audit
 * entry (`gateway.key.reconcile`, `cause`).
 *
 * `narrow: false` (on SAVE, or before a run while another run of the system is active) only WIDENS: the key keeps what it
 * has and gains what the definition adds — a run in flight still holds the definition it started with, so nothing it may
 * call is taken away under it. `narrow: true` (before a run with no other run of the system active) makes the fields
 * exactly the definition. The Build and the periodic reconcile also narrow.
 *
 * A system never built, a key the OS does not own and a replacement in flight are left alone. A gateway that cannot be
 * read or written is `unreachable` with the reason — the caller goes on (a run then gets the gateway's own answer).
 */
export async function syncDerivedKeyFields(input: {
  systemId: string;
  /** The definition as the Build keys it (grants governed for the owner). */
  yaml: string;
  domain: string;
  actor: string;
  cause: KeySyncCause;
  narrow: boolean;
  deps: LiveDeps;
  audit?: typeof audit;
}): Promise<KeySyncOutcome> {
  const { systemId, deps } = input;
  const alias = systemKeyAlias(systemId);
  try {
    if (await deps.keys.journal.staged(systemId)) return { state: 'in-flight', changes: [] };
    const record = await deps.keys.store.get(systemId);
    if (!record) return { state: 'not-built', changes: [] };
    const atGateway = await deps.litellm.keysByAlias(alias);
    if (atGateway.length !== 1 || atGateway[0].tokenId !== record.tokenId) return { state: 'not-ours', changes: [] };
    const have = atGateway[0];
    const system = parseSystem(input.yaml);
    const want = await keyWanted(deps)({ system, ir: compile(system), systemId });
    const target = derivedTarget(have, want, input.narrow);
    const changes: string[] = [];
    if (!sameSet(have.models, target.models)) changes.push(`models ${[...have.models].sort().join(', ') || 'none'} → ${target.models.join(', ')}`);
    if (have.allowedTools === undefined || !sameSet(have.allowedTools, target.allowedTools)) changes.push(`allowed tools ${have.allowedTools?.length ?? 'none'} → ${target.allowedTools.length}`);
    // An older stamp with nothing else to change is still re-stamped (the reconcile would otherwise flag it).
    if (changes.length === 0 && (have.allowedToolsRev ?? 1) >= ALLOWED_TOOLS_REV) return { state: 'in-sync', changes };
    await deps.litellm.updateDerivedFields(have.tokenId, { models: target.models, allowedTools: target.allowedTools, metadata: have.metadata });
    (input.audit ?? audit)({
      actor: input.actor,
      action: 'gateway.key.reconcile',
      subject: alias,
      domain: input.domain,
      reason: input.cause === 'pre-run-sync'
        ? `before a run, the key's OS-derived fields were brought to the definition (${changes.join('; ') || 'stamp'})`
        : `the definition was saved, and the key gained what it now needs (${changes.join('; ') || 'stamp'})`,
      detail: { outcome: 'corrected', cause: input.cause, mode: input.narrow ? 'exact' : 'widen', changes },
    });
    return { state: 'synced', changes };
  } catch (e) {
    return { state: 'unreachable', changes: [], error: (e as Error)?.message ?? String(e) };
  }
}

/** One serial chain per system for every key sync (save and pre-run), so an older definition never overwrites a newer one. */
const CHAINS = Symbol.for('soa.agents.key-sync-chains');
function chainFor(systemId: string): { run<T>(fn: () => Promise<T>): Promise<T> } {
  const g = globalThis as unknown as Record<symbol, Map<string, Promise<unknown>> | undefined>;
  g[CHAINS] ??= new Map();
  const chains = g[CHAINS]!;
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const prev = chains.get(systemId) ?? Promise.resolve();
      // The next sync runs after this one whether it worked or not (`then(fn, fn)`); the caller handles its outcome.
      const next = prev.then(fn, fn);
      chains.set(systemId, next);
      return next;
    },
  };
}

/** Run a key sync in the system's serial chain (exported for tests of the interleaving). */
export function inSystemKeyChain<T>(systemId: string, fn: () => Promise<T>): Promise<T> {
  return chainFor(systemId).run(fn);
}

/** Is another run of this system active (queued, running or parked)? Then a pre-run sync only widens. */
async function otherRunActive(systemId: string, runId: string | undefined): Promise<boolean> {
  const { runJobStore } = await import('@tabs/agents/lib/build/run-jobs-server');
  const rows = await (await runJobStore()).listRuns({ systemId, statuses: ['queued', 'running', 'parked'], limit: 5 });
  return rows.some((r) => r.runId !== runId);
}

/**
 * The live wiring for one system (web process only — it needs the gateway's admin API), IN the system's serial chain:
 * the definition is read when the sync's turn comes (so the newest save wins), governed for its owner exactly as the
 * Build and the reconcile see it. Save: widen only, and nothing for an archived system. Pre-run: exact when no other run
 * of the system is active, else widen. Never throws; logs anything but `in-sync`.
 */
export async function syncDerivedKeyFieldsLive(systemId: string, cause: KeySyncCause, actor = 'system:os-ui', runId?: string): Promise<KeySyncOutcome | null> {
  if (!liteLlmConfigured()) return null;
  return inSystemKeyChain(systemId, async () => {
    const [{ systemForScheduler }, { governYamlForOwner }, { makeRealClients }] = await Promise.all([
      import('@tabs/agents/lib/store'),
      import('@tabs/agents/lib/build/owner-grants'),
      import('@tabs/agents/lib/build/live-clients'),
    ]);
    const rec = systemForScheduler(systemId);
    if (!rec || (cause === 'save-sync' && rec.archived)) return null;
    const narrow = cause === 'pre-run-sync' ? !(await otherRunActive(systemId, runId)) : false;
    const out = await syncDerivedKeyFields({ systemId, yaml: await governYamlForOwner(rec.yaml, rec.owner), domain: rec.domain, actor, cause, narrow, deps: makeRealClients() });
    if (out.state === 'synced') console.info(`[key-sync] ${cause} '${systemKeyAlias(systemId)}' (${narrow ? 'exact' : 'widen'}): ${out.changes.join('; ')}`);
    if (out.state === 'unreachable') console.warn(`[key-sync] ${cause} '${systemKeyAlias(systemId)}': the gateway could not be read or written (${out.error}) — going on; the gateway answers the run itself`);
    return out;
  });
}

/**
 * ON SAVE: every change to a system's definition (the files PUT, the canvas, the assistant, MCP create/commit, a
 * restore, the Build's Auto decision) WIDENS the key's OS-derived fields — in the system's serial chain, off the request.
 * Returns the unsubscribe function.
 */
export function installKeySyncOnSave(sync: (systemId: string) => Promise<unknown> = (id) => syncDerivedKeyFieldsLive(id, 'save-sync')): () => void {
  return onSystemChange((change) => {
    if (/^(delete|archive)/.test(change.action)) return;
    void Promise.resolve()
      .then(() => sync(change.systemId))
      .catch((e: unknown) => console.warn(`[key-sync] save-sync '${change.systemId}': ${e instanceof Error ? e.message : String(e)}`));
  });
}
