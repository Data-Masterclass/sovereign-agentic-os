/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        agents
 * FEATURE:    Admin actions on an agent system's model key: rotate it, remove it with the
 *             system, and list which systems have a usable key.
 * USER STORY: As a platform admin I can replace one system's model key on demand (the old value
 *             stops working, the system keeps running), and I can see at a glance which systems
 *             still need a Build before they can run.
 *             As a system owner, deleting my system also deletes its key at the gateway.
 * ARCHITECTURE:
 *   - ROTATION is the OSS way — mint new, swap, delete old — because LiteLLM's own rotation
 *     endpoints (`/key/{key}/regenerate`, auto-rotate) are Enterprise. It is not a second code
 *     path: it runs the Build's `litellm` step with `rotateKey`, so the new key gets exactly the
 *     models and caps a Rebuild would give it, is stored the same way and is verified the same way.
 *   - IN-FLIGHT RUNS: the run path reads the key from the store on each model call. A call that
 *     lands in the moment between "old deleted" and "new stored" is answered 401; the model
 *     caller re-reads the store, waits briefly if the new key is not there yet, and repeats the
 *     call once with the new key (`core/runtime/runtime.ts`). A run only fails if the rotation
 *     itself failed — and then with "press Rebuild", because the system has no key.
 *   - Server-side in os-ui web only: these need the gateway's admin API (the master key), which
 *     the worker is deliberately not given.
 */
import 'server-only';
import { type KeyDriftEntry } from '@core/infra/agent-key-drift';
import { durableSystemKeyStore, forgetSystemKey, systemKeyStatus, type SystemKeyStatus } from '@core/infra/agent-system-keys';
import { type BuildRow } from '@tabs/agents/lib/build/adapter';
import { orchestrateBuild } from '@tabs/agents/lib/build/orchestrate';
import { makeLiveAdapters, type LiveDeps } from '@tabs/agents/lib/build/live';
import { gatewayAdminReachable, makeRealClients } from '@tabs/agents/lib/build/live-clients';

export type RotateOutcome = { ok: boolean; row: BuildRow | null; error?: string };

/** Replace one system's key: the Build's `litellm` step alone, with `rotateKey`. */
export async function rotateSystemKeyWith(systemId: string, yaml: string, deps: LiveDeps): Promise<RotateOutcome> {
  const adapters = makeLiveAdapters(deps).filter((a) => a.tool === 'litellm');
  const report = await orchestrateBuild({ yaml, systemId, adapters, probe: 'Key rotation', rotateKey: true });
  const row = report.rows.find((r) => r.tool === 'litellm') ?? report.rows[0] ?? null;
  return { ok: report.ok && row?.tool === 'litellm', row, ...(report.ok ? {} : { error: row?.error ?? 'the key was not rotated' }) };
}

/** Rotate against the real gateway. Refuses, changing nothing, when the gateway cannot be reached. */
export async function rotateSystemKey(systemId: string, yaml: string): Promise<RotateOutcome> {
  if (!(await gatewayAdminReachable())) {
    return { ok: false, row: null, error: 'The model gateway\'s admin API is unreachable, so the key was not rotated. Nothing was changed.' };
  }
  return rotateSystemKeyWith(systemId, yaml, makeRealClients());
}

/**
 * "Re-apply from the OS": put one system's key back to what its definition says (models, budget,
 * limits, allowed tools) WITHOUT changing its value — the Build's `litellm` step alone
 * (`reapplyAudited`, `key-reconcile.ts`), with one audit entry. Refuses, changing nothing, when the gateway cannot be reached.
 */
export async function reapplySystemKey(
  systemId: string,
  yaml: string,
  by: { actor: string; domain: string; drift?: Pick<KeyDriftEntry, 'kind' | 'changes'> },
): Promise<{ ok: boolean; detail: string; error?: string }> {
  if (!(await gatewayAdminReachable())) {
    return { ok: false, detail: '', error: 'The model gateway\'s admin API is unreachable, so the key was not re-applied. Nothing was changed.' };
  }
  const { reapplyAudited } = await import('@tabs/agents/lib/build/key-reconcile');
  return reapplyAudited({ systemId, yaml, ...by, deps: makeRealClients() });
}

/**
 * Remove a DELETED system's key: at the gateway (so the value stops working) and from the store.
 * Best-effort and honest — a gateway that cannot be reached is reported, the store row still goes.
 */
export async function removeSystemKeyWith(systemId: string, deps: Pick<LiveDeps, 'litellm' | 'keys'>): Promise<{ ok: boolean; detail: string }> {
  const alias = `os-${systemId}`;
  let gateway = '';
  try {
    const keys = await deps.litellm.keysByAlias(alias);
    for (const k of keys) await deps.litellm.deleteKey(k.tokenId);
    gateway = keys.length > 0 ? `deleted ${keys.length} key(s) at the gateway` : 'no key at the gateway';
  } catch (e) {
    gateway = `gateway key NOT deleted: ${(e as Error).message}`;
  }
  let stored = 'stored copy removed';
  try {
    await deps.keys.store.delete(systemId);
  } catch (e) {
    stored = `stored copy NOT removed: ${(e as Error).message}`;
  }
  forgetSystemKey(systemId);
  return { ok: !gateway.includes('NOT deleted') && !stored.includes('NOT removed'), detail: `${gateway}; ${stored}` };
}

export async function removeSystemKey(systemId: string): Promise<{ ok: boolean; detail: string }> {
  if (!(await gatewayAdminReachable())) {
    // No gateway (a laptop, or an outage). A system that never had a stored key has nothing to
    // clean up; one that had is reported, because its key is still registered at the gateway.
    let had: unknown;
    try {
      had = await durableSystemKeyStore.get(systemId);
      await durableSystemKeyStore.delete(systemId);
    } catch (e) {
      forgetSystemKey(systemId);
      return { ok: false, detail: `the gateway is unreachable and the key store could not be read or updated (${(e as Error).message}); key os-${systemId} may still be registered — remove it once both are back` };
    }
    forgetSystemKey(systemId);
    return had
      ? { ok: false, detail: `the gateway is unreachable, so key os-${systemId} was NOT deleted there; its stored copy was removed` }
      : { ok: true, detail: 'no key to remove' };
  }
  return removeSystemKeyWith(systemId, makeRealClients());
}

/** One system's key state for the admin list — never any key material. */
export type SystemKeyRow = { systemId: string; name: string } & SystemKeyStatus;

export async function listSystemKeyRows(systems: { id: string; name: string }[]): Promise<SystemKeyRow[]> {
  const out: SystemKeyRow[] = [];
  for (const s of systems) out.push({ systemId: s.id, name: s.name, ...(await systemKeyStatus(s.id)) });
  return out;
}

/** Stored keys whose system no longer exists (deleted before keys were cleaned up with the system). */
export async function orphanedKeyRecords(systemIds: string[]): Promise<string[]> {
  const known = new Set(systemIds);
  return (await durableSystemKeyStore.list()).map((r) => r.systemId).filter((id) => !known.has(id));
}
