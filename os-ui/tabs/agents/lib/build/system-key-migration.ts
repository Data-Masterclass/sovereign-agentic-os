/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    The one-time move of every existing agent system onto a random, budgeted model
 *             key of its own — without any system stopping.
 *
 * USER STORY: As a system owner, after the upgrade my system (and its schedule) keeps running
 *             without me pressing Rebuild; from then on it spends on its own budgeted key.
 *             As a security reviewer, once a system has been moved, its old guessable key and
 *             its old unbudgeted key no longer work.
 *             As a platform admin, every move is in the audit log, and a crash half-way through
 *             is finished by the next run, never repeated with a second key.
 *
 * ARCHITECTURE:
 *   - ONE CODE PATH. Each system goes through the Build's own `litellm` step
 *     (`makeLiveAdapters(...).litellm`), exactly as Rebuild does: same models, same caps, same
 *     verification. That step replaces a key MAKE-BEFORE-BREAK through the journal in
 *     `core/infra/agent-system-keys.ts`: stage the new value → move the old key off the alias
 *     (still working) → register → swap into the store → delete the old key.
 *   - WHICH SYSTEMS: every system in the registry that has no stored, readable key the gateway
 *     still holds, or that has a replacement left half-done in the journal. A system that is
 *     already fine is not touched (its caps are not re-written behind its owner's back).
 *   - THE REGISTRY MUST BE REAL. `listSystemsForKeyMigration()` is null unless the registry
 *     hydrated from the durable mirror; then nothing runs and nothing is marked done.
 *   - DONE MARKER. When every system has been processed without a failure, the migration is
 *     marked done in the journal table. Until then, a run of a system with no stored key WAITS
 *     for its key (`resolveSystemKey`) instead of failing. A system that cannot be migrated (its
 *     definition no longer parses, the gateway refuses it) keeps the marker unset; the boot
 *     schedule retries, and its runs fail after the wait with "press Build".
 *   - AFTER the migration the sweep removes what nothing can be running on: derivable keys of
 *     systems that no longer exist, and the unbudgeted reconcile keys.
 *   - AUDITED: one `gateway.key.migrate` entry per system moved or failed (alias, outcome, what
 *     changed) — never a key, a token id or a guessable value.
 *   - os-ui web only: the gateway's admin API needs the master key, which the worker does not have.
 */
import 'server-only';
import { scheduleEvery } from '@core/reconcile/runtime';
import { record as audit } from '@core/policy/audit';
import { liteLlmConfigured } from '@core/infra/litellm-admin';
import { sweepLegacySystemKeys, type KeySweepResult } from '@core/infra/agent-system-key-sweep';
import {
  PRE_RANDOM_KEY_MIGRATION,
  systemKeyAlias,
  tryOpenSystemKey,
  type Kek,
  type SystemKeyJournal,
  type SystemKeyStore,
} from '@core/infra/agent-system-keys';
import { orchestrateBuild } from '@tabs/agents/lib/build/orchestrate';
import { makeLiveAdapters, type LiteLlmClient, type LiveDeps } from '@tabs/agents/lib/build/live';

export type MigrationSystem = { id: string; domain: string; owner: string; yaml: string };

export type KeyMigrationResult = {
  at: number;
  /** false = the registry was not readable, or at least one system could not be moved. */
  ok: boolean;
  done: boolean;
  scanned: number;
  migrated: string[];
  alreadyFine: number;
  failed: { alias: string; error: string }[];
  error?: string;
};

export type KeyMigrationIo = {
  /** The existing systems, or null when the registry cannot be trusted (not hydrated). */
  systems: () => Promise<MigrationSystem[] | null>;
  /** The definition the Build would use for this owner (grants governed for them). */
  governYaml: (yaml: string, owner: string) => Promise<string>;
  deps: LiveDeps;
  now?: () => number;
  log?: (line: string) => void;
  audit?: typeof audit;
};

/** Does this system still need moving? (No readable stored key the gateway holds, or a half-done replacement.) */
async function needsMigration(id: string, store: SystemKeyStore, journal: SystemKeyJournal, kek: Kek, litellm: LiteLlmClient): Promise<boolean> {
  if (await journal.staged(id)) return true;
  const record = await store.get(id);
  if (!record) return true;
  if (!tryOpenSystemKey(record, kek).ok) return true;
  const atGateway = await litellm.keysByAlias(systemKeyAlias(id));
  return !atGateway.some((k) => k.tokenId === record.tokenId);
}

/** One migration pass over injected IO. Every system is attempted; failures come back as data. */
export async function runKeyMigration(io: KeyMigrationIo): Promise<KeyMigrationResult> {
  const now = io.now ?? Date.now;
  const log = io.log ?? ((line: string) => console.info(`[key-migration] ${line}`));
  const write = io.audit ?? audit;
  const at = now();
  const systems = await io.systems();
  if (systems === null) {
    log('the agent registry has not hydrated from the mirror yet — nothing migrated, will retry');
    return { at, ok: false, done: false, scanned: 0, migrated: [], alreadyFine: 0, failed: [], error: 'registry not hydrated' };
  }
  const { store, journal } = io.deps.keys;
  const kek = io.deps.keys.kek();
  const result: KeyMigrationResult = { at, ok: true, done: false, scanned: systems.length, migrated: [], alreadyFine: 0, failed: [] };
  const litellmOnly = makeLiveAdapters(io.deps).filter((a) => a.tool === 'litellm');
  for (const s of systems) {
    const alias = systemKeyAlias(s.id);
    let error: string | undefined;
    let detail = '';
    try {
      if (!(await needsMigration(s.id, store, journal, kek, io.deps.litellm))) {
        result.alreadyFine += 1;
        continue;
      }
      const yaml = await io.governYaml(s.yaml, s.owner);
      const report = await orchestrateBuild({ yaml, systemId: s.id, adapters: litellmOnly, probe: 'Key migration' });
      const row = report.rows.find((r) => r.tool === 'litellm');
      if (report.ok && row) detail = row.appliedDetail ?? '';
      else error = row?.error ?? 'the key step did not complete';
    } catch (e) {
      error = (e as Error)?.message ?? String(e);
    }
    if (error === undefined) {
      result.migrated.push(alias);
      log(`moved '${alias}' onto its own random, budgeted key`);
    } else {
      result.ok = false;
      result.failed.push({ alias, error });
      log(`could NOT move '${alias}': ${error}`);
    }
    write({
      actor: 'system:os-ui',
      action: 'gateway.key.migrate',
      subject: alias,
      domain: s.domain,
      reason: error === undefined ? 'moved onto a random, budgeted key; the old key was deleted after the new one was in use' : `not moved: ${error}`,
      detail: { migration: PRE_RANDOM_KEY_MIGRATION, outcome: error === undefined ? 'migrated' : 'failed', ...(detail ? { change: detail } : {}) },
    });
  }
  if (result.failed.length === 0) {
    await journal.markMigrationDone(PRE_RANDOM_KEY_MIGRATION, now());
    result.done = true;
  }
  log(`pass done — ${result.scanned} system(s), ${result.migrated.length} moved, ${result.alreadyFine} already fine, ${result.failed.length} failed`);
  return result;
}

type Slot = { last?: KeyMigrationResult; booted?: boolean };
const g = globalThis as unknown as { __osKeyMigration?: Slot };
const slot = (): Slot => (g.__osKeyMigration ??= {});

/** The last migration pass this process ran, for the Admin view. */
export function lastKeyMigration(): KeyMigrationResult | null {
  return slot().last ?? null;
}

/** How often an unfinished migration is retried. */
const RETRY_MS = 120_000;

/**
 * At boot of os-ui web: migrate, then sweep what nothing can be running on — and repeat every
 * two minutes (through the one timer module) until both have completed once. Boot never waits
 * for this; a failure is logged, never thrown into boot.
 */
export function scheduleBootKeyMigration(pass: () => Promise<{ migration: KeyMigrationResult; sweep: KeySweepResult | null }>, retryMs: number = RETRY_MS): void {
  if (slot().booted || !liteLlmConfigured()) return;
  slot().booted = true;
  let stop: (() => void) | undefined;
  let finished = false;
  const tick = async () => {
    if (finished) return;
    const { migration, sweep } = await pass();
    slot().last = migration;
    if (migration.done && sweep && !sweep.error && sweep.ok) {
      finished = true;
      stop?.();
    }
  };
  stop = scheduleEvery('agent-system-key-migration', retryMs, tick);
  void tick().catch((e) => console.error(`[key-migration] first attempt failed: ${(e as Error)?.message ?? String(e)}`));
}

/** One full pass: migrate every existing system, then (only if the registry was readable) sweep. */
export async function migrateThenSweep(io: KeyMigrationIo): Promise<{ migration: KeyMigrationResult; sweep: KeySweepResult | null }> {
  const migration = await runKeyMigration(io);
  if (migration.error) return { migration, sweep: null };
  const systems = (await io.systems()) ?? null;
  const keep = systems === null ? 'all' : new Set(systems.map((s) => systemKeyAlias(s.id)));
  return { migration, sweep: await sweepLegacySystemKeys(keep) };
}

/** The real wiring: this registry, this gateway, this store. */
export async function migrateThenSweepLive(): Promise<{ migration: KeyMigrationResult; sweep: KeySweepResult | null }> {
  const [{ ensureHydrated, listSystemsForKeyMigration }, { governYamlForOwner }, { makeRealClients }] = await Promise.all([
    import('@tabs/agents/lib/store'),
    import('@tabs/agents/lib/build/owner-grants'),
    import('@tabs/agents/lib/build/live-clients'),
  ]);
  const out = await migrateThenSweep({
    systems: async () => {
      await ensureHydrated();
      return listSystemsForKeyMigration();
    },
    governYaml: governYamlForOwner,
    deps: makeRealClients(),
  });
  slot().last = out.migration;
  return out;
}
