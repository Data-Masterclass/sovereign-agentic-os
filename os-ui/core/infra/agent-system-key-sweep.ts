/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Remove the model keys the OS must no longer leave at the gateway: the old
 *             GUESSABLE per-system keys, and the unbudgeted keys the admin reconcile used to make.
 *
 * USER STORY: As a security reviewer, after this version is deployed no key at the gateway can be
 *             worked out from a system id — including for systems nobody has rebuilt yet.
 *             As a platform admin, I can see when the sweep last ran, what it deleted and what it
 *             could not, and I can run it again by hand.
 *
 * ARCHITECTURE:
 *   TWO kinds of key are deleted, and each is recognised from what the GATEWAY reports, never
 *   from what the OS store believes (a store that hydrated empty must not be able to delete
 *   anything — os-ui/ARCHITECTURE.md, "a boot-time writer"):
 *     derivable   alias `os-…` whose token id equals SHA-256(`sk-<alias>`): the value the OS
 *                 used to give a system's key. The test is on the HASH LiteLLM reports; the
 *                 guessable value is never sent anywhere. A key under the same alias with any
 *                 other token id is a random key and is left alone.
 *     unbudgeted  alias `agent-<id>` carrying the reconcile's own stamp (`metadata.os_owner =
 *                 agent`, `os_id = <id>`) and no `max_budget`: the second key scheme, created by
 *                 `tabs/admin/lib/litellm-reconcile.ts` before Build issued per-system keys. Their
 *                 values were never kept by the OS, they have no budget and no model restriction.
 *   A hand-made key, a budgeted `agent-…` key and every other key are not touched.
 *
 *   A swept system has NO key until its next Build; its runs stop with "press Build" (see
 *   `agent-system-keys.ts`). That is the intended trade: a run that waits for a Rebuild is a
 *   smaller harm than a working key anyone can guess.
 *
 *   IDEMPOTENT: a second run finds nothing. Runs server-side in os-ui web only — the worker has
 *   no master key, so `liteLlmConfigured()` is false there and the sweep reports "not configured".
 *   `scheduleBootKeySweep` runs it once at boot and retries while the gateway is not reachable
 *   yet. Logs carry aliases and counts, never a key or a token id.
 */
import 'server-only';
import { liteLlmConfigured, readAllKeys, type Fetched, type LiteLlmKeyRow } from '@core/infra/litellm-admin';
import { adminPost } from '@core/infra/litellm-write';
import { isLegacyDerivedToken } from '@core/infra/agent-system-keys';

export type SweepTarget = { alias: string; tokenId: string; reason: 'derivable' | 'unbudgeted-agent-key' };

/** Which keys the sweep would delete. PURE — the whole decision is testable without a gateway. */
export function planKeySweep(rows: LiteLlmKeyRow[]): SweepTarget[] {
  const out: SweepTarget[] = [];
  for (const row of rows) {
    const alias = typeof row.key_alias === 'string' ? row.key_alias : '';
    const tokenId = typeof row.token === 'string' ? row.token : '';
    if (!alias || !tokenId) continue;
    if (alias.startsWith('os-') && isLegacyDerivedToken(alias, tokenId)) {
      out.push({ alias, tokenId, reason: 'derivable' });
      continue;
    }
    const meta = row.metadata ?? {};
    const stamped = meta.os_owner === 'agent' && typeof meta.os_id === 'string' && alias === `agent-${meta.os_id}`;
    if (stamped && (row.max_budget === null || row.max_budget === undefined)) {
      out.push({ alias, tokenId, reason: 'unbudgeted-agent-key' });
    }
  }
  return out;
}

export type KeySweepResult = {
  at: number;
  /** false = the gateway could not be listed (nothing was deleted), or a delete failed. */
  ok: boolean;
  scanned: number;
  deleted: { alias: string; reason: SweepTarget['reason'] }[];
  failed: { alias: string; error: string }[];
  /** Why nothing could be done, when the listing itself failed. */
  error?: string;
};

export type KeySweepIo = {
  list: () => Promise<Fetched<LiteLlmKeyRow[]>>;
  deleteKey: (tokenId: string) => Promise<Fetched<unknown>>;
  now?: () => number;
  log?: (line: string) => void;
};

/** One sweep over injected IO. Each delete is attempted independently; failures come back as data. */
export async function runKeySweep(io: KeySweepIo): Promise<KeySweepResult> {
  const at = (io.now ?? Date.now)();
  const log = io.log ?? ((line: string) => console.info(`[key-sweep] ${line}`));
  const listed = await io.list();
  if (!listed.ok) {
    log(`could not list the gateway's keys (${listed.error}) — nothing deleted`);
    return { at, ok: false, scanned: 0, deleted: [], failed: [], error: listed.error };
  }
  const result: KeySweepResult = { at, ok: true, scanned: listed.data.length, deleted: [], failed: [] };
  for (const target of planKeySweep(listed.data)) {
    const res = await io.deleteKey(target.tokenId);
    if (res.ok) {
      result.deleted.push({ alias: target.alias, reason: target.reason });
      log(`deleted key '${target.alias}' (${target.reason})`);
    } else {
      result.ok = false;
      result.failed.push({ alias: target.alias, error: res.error });
      log(`FAILED to delete key '${target.alias}' (${target.reason}): ${res.error}`);
    }
  }
  log(`done — ${result.scanned} key(s) scanned, ${result.deleted.length} deleted, ${result.failed.length} failed`);
  return result;
}

type Slot = { last?: KeySweepResult; booted?: boolean };
const g = globalThis as unknown as { __osKeySweep?: Slot };
const slot = (): Slot => (g.__osKeySweep ??= {});

/** The last sweep this process ran (boot or by hand), for the Admin view. */
export function lastKeySweep(): KeySweepResult | null {
  return slot().last ?? null;
}

/** Run the sweep against the real gateway and remember the result. */
export async function sweepLegacySystemKeys(): Promise<KeySweepResult> {
  const result = liteLlmConfigured()
    ? await runKeySweep({ list: () => readAllKeys(), deleteKey: (tokenId) => adminPost('/key/delete', { keys: [tokenId] }, 8000) })
    : { at: Date.now(), ok: false, scanned: 0, deleted: [], failed: [], error: 'LiteLLM admin access is not configured in this process' };
  slot().last = result;
  return result;
}

/** Delays between boot attempts: the gateway is often not up yet when os-ui starts. */
const BOOT_RETRY_MS = [0, 30_000, 120_000, 600_000];

/**
 * Run the sweep ONCE per process at boot, retrying while the gateway cannot be listed. Not
 * awaited by the caller — boot never waits on the gateway — and a failure is only ever logged.
 */
export function scheduleBootKeySweep(sweep: () => Promise<KeySweepResult> = sweepLegacySystemKeys, delays: readonly number[] = BOOT_RETRY_MS): void {
  if (slot().booted || !liteLlmConfigured()) return;
  slot().booted = true;
  const attempt = (i: number) => {
    const timer = setTimeout(() => {
      void sweep()
        .then((r) => { if (r.error && i + 1 < delays.length) attempt(i + 1); })
        .catch((e) => console.error(`[key-sweep] attempt failed: ${(e as Error)?.message ?? String(e)}`));
    }, delays[i]);
    (timer as { unref?: () => void }).unref?.();
  };
  attempt(0);
}
