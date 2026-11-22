/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * SystemKeysPanel — the model key of each agent system, for platform admins.
 *
 * FEATURE:
 *   • One row per agent system: does it have a usable key of its own, when was the key
 *     issued or last replaced, and its budget and limits.
 *   • The key migration (existing systems moved onto random, budgeted keys, make-before-break)
 *     and the sweep after it: when they last ran, what they did, what failed — and a button to
 *     run both again.
 *   • "Replace key" per system: a new random key, the old one stops working.
 *   • DRIFT: the continuous reconcile compares each system's key at the gateway with its
 *     definition. A key someone changed in LiteLLM shows here with what differs and since when,
 *     and "Re-apply from the OS" puts it back WITHOUT changing the key value (audited). By
 *     default nothing is overwritten automatically; auto-correct is a deployment value per system.
 *
 * USER STORY:
 *   • As a platform admin I see which systems still need a Build before they can run, so a
 *     failed scheduled run is never the first I hear of it.
 *   • As a platform admin I manage keys centrally and never hold one: nothing on this panel
 *     shows a key, and nothing here lets me copy one.
 *
 * ARCHITECTURE:
 *   A thin client component over `/api/platform-admin/gateway/system-keys`. Every rule — what
 *   counts as usable, what the sweep deletes, how a rotation is done — lives on the server
 *   (`core/infra/agent-system-keys.ts`, `agent-system-key-sweep.ts`,
 *   `tabs/agents/lib/build/system-key-admin.ts`). The two actions post an action NAME and a
 *   system id; the server decides everything else.
 */
'use client';

import { useState } from 'react';
import { useApi } from '@core/ui/useApi';

type KeyRow = {
  systemId: string;
  name: string;
  state: 'ready' | 'missing' | 'unreadable' | 'not-configured' | 'store-unavailable';
  message?: string;
  createdAt?: number;
  rotatedAt?: number | null;
  caps?: { models: string[]; maxBudget: number; budgetDuration: string; rpmLimit: number; tpmLimit: number; maxParallelRequests: number };
};
type Sweep = { at: number; ok: boolean; scanned: number; deleted: { alias: string; reason: string }[]; failed: { alias: string; error: string }[]; error?: string };
type Migration = { at: number; ok: boolean; done: boolean; scanned: number; migrated: string[]; alreadyFine: number; failed: { alias: string; error: string }[]; error?: string };
type DriftEntry = { systemId: string; alias: string; kind: 'drift' | 'missing' | 'duplicate' | 'not-ours'; changes: string[]; firstSeenAt: number; action: 'alert' | 'corrected' | 'correction-failed'; error?: string };
type Reconcile = { at: number; ok: boolean; scanned: number; inSync: number; notBuilt: number; inFlight: number; entries: DriftEntry[]; unchecked: { systemId: string; error: string }[]; error?: string };
type Payload = {
  systems: KeyRow[];
  sweep: Sweep | null;
  migration?: Migration | null;
  reconcile?: Reconcile | null;
  reconcileMode?: { intervalSeconds: number; autoCorrect: 'all' | string[] };
};

const STATE_LABEL: Record<KeyRow['state'], string> = {
  ready: 'Has its own key',
  missing: 'No key — needs a Build',
  unreadable: 'Key unreadable — needs a Rebuild',
  'not-configured': 'Encryption secret missing',
  'store-unavailable': 'Key store unreachable',
};

const when = (ms?: number | null) => (ms ? new Date(ms).toLocaleString() : '—');

function sweepLine(sweep: Sweep | null): string {
  if (sweep === null) return 'has not run in this process yet (it runs at start-up, once the gateway is reachable).';
  if (sweep.error) return `${when(sweep.at)} — could not list the gateway's keys (${sweep.error}); nothing was deleted.`;
  const failed = sweep.failed.length ? `, ${sweep.failed.length} could NOT be deleted` : '';
  return `${when(sweep.at)} — ${sweep.scanned} key(s) checked, ${sweep.deleted.length} deleted${failed}.`;
}

function migrationLine(m: Migration | null): string {
  if (m === null) return 'has not run in this process yet (it runs at start-up, once the gateway is reachable).';
  if (m.error) return `${when(m.at)} — not run (${m.error}); nothing was changed.`;
  const failed = m.failed.length ? `, ${m.failed.length} could NOT be moved` : '';
  return `${when(m.at)} — ${m.scanned} system(s): ${m.migrated.length} moved onto their own key, ${m.alreadyFine} already had one${failed}.${m.done ? '' : ' Will retry.'}`;
}

function reconcileLine(r: Reconcile | null | undefined, mode: Payload['reconcileMode']): string {
  const how = !mode ? '' : mode.intervalSeconds <= 0
    ? ' The check is switched off.'
    : ` Checked every ${Math.round(mode.intervalSeconds / 60) || 1} min; ${mode.autoCorrect === 'all' ? 'every system is put back automatically' : mode.autoCorrect.length ? `put back automatically only for: ${mode.autoCorrect.join(', ')}` : 'nothing is changed automatically, differences are only reported'}.`;
  if (!r) return `has not run in this process yet (the first check is one interval after start-up).${how}`;
  if (!r.ok) return `${when(r.at)} — could not check every key (${r.error ?? r.unchecked.map((u) => `${u.systemId}: ${u.error}`).join('; ')}); nothing is shown as in sync that was not read.${how}`;
  return `${when(r.at)} — ${r.scanned} system(s): ${r.inSync} match their definition, ${r.entries.filter((e) => e.action !== 'corrected').length} differ, ${r.notBuilt} not built yet.${how}`;
}

const DRIFT_LABEL: Record<DriftEntry['kind'], string> = {
  drift: 'Changed at the gateway',
  missing: 'Key deleted at the gateway',
  duplicate: 'More than one key',
  'not-ours': 'Not the key the OS stored',
};

function capsLine(caps: KeyRow['caps']): string {
  if (!caps) return '—';
  const budget = caps.budgetDuration ? `$${caps.maxBudget} per ${caps.budgetDuration}` : `$${caps.maxBudget} in total`;
  return `${budget} · ${caps.rpmLimit} requests/min · ${caps.tpmLimit} tokens/min · ${caps.maxParallelRequests} at once · ${caps.models.length} model(s)`;
}

export default function SystemKeysPanel() {
  const { data, loading, error, reload } = useApi<Payload>('/api/platform-admin/gateway/system-keys');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState('');

  const act = async (action: 'sweep' | 'rotate' | 'reapply', systemId?: string) => {
    setBusy(action === 'reapply' ? `reapply:${systemId}` : (systemId ?? action));
    setNote('');
    try {
      const res = await fetch('/api/platform-admin/gateway/system-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, systemId }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; row?: { appliedDetail?: string; error?: string } | null };
      const why = body.error ?? body.row?.error ?? `request failed (${res.status})`;
      if (action === 'reapply') setNote(res.ok ? `Key of ${systemId} re-applied from its definition (the key value did not change).` : `Key of ${systemId} NOT re-applied: ${why}`);
      else if (action === 'rotate') setNote(res.ok ? `Key replaced for ${systemId}. ${body.row?.appliedDetail ?? ''}` : `Key NOT replaced for ${systemId}: ${why}`);
      else if (!res.ok) setNote(`Migration failed: ${why}`);
      await reload();
    } catch (e) {
      setNote(`Request failed: ${(e as Error).message}`);
    } finally {
      setBusy('');
    }
  };

  const sweep = data?.sweep ?? null;
  const driftOf = new Map((data?.reconcile?.entries ?? []).filter((e) => e.action !== 'corrected').map((e) => [e.systemId, e]));
  const needBuild = (data?.systems ?? []).filter((s) => s.state !== 'ready').length;

  return (
    <section className="card" style={{ marginTop: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <h2 style={{ fontFamily: 'var(--font-head)', fontSize: 16, margin: 0 }}>Agent system model keys</h2>
        <button className="btn" onClick={() => act('sweep')} disabled={busy !== ''}>
          {busy === 'sweep' ? <span className="spin" /> : 'Move old keys now'}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
        Each agent system calls the models with its own key, so its budget and limits apply to it alone. Keys are random,
        stored encrypted, and never shown. A system without a usable key does not run until it is built.
      </p>

      {loading ? <p className="muted" style={{ fontSize: 13, margin: 0 }}>Reading the key store…</p> : null}
      {error ? <p style={{ fontSize: 13, margin: 0 }}>Could not read the key status: {error}</p> : null}
      {note ? <p role="status" style={{ fontSize: 13, margin: '0 0 10px' }}>{note}</p> : null}

      {data ? (
        <>
          <p style={{ fontSize: 13, margin: '0 0 10px' }}>
            <strong>Key migration:</strong> {migrationLine(data.migration ?? null)}
          </p>
          {data.migration && data.migration.failed.length > 0 ? (
            <p style={{ fontSize: 12, margin: '0 0 10px' }}>Not moved: {data.migration.failed.map((f) => `${f.alias} (${f.error})`).join(', ')}. Its old key is kept until it is moved.</p>
          ) : null}
          <p style={{ fontSize: 13, margin: '0 0 10px' }}>
            <strong>Drift check:</strong> {reconcileLine(data.reconcile, data.reconcileMode)}
          </p>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
            Who owns what: the platform team owns providers, models and global budgets in LiteLLM, and may also edit a system&apos;s key there.
            The OS owns what each system&apos;s key should be (models, budget, limits, allowed tools — from the system&apos;s grants) and tells you when the gateway differs.
          </p>
          <p style={{ fontSize: 13, margin: '0 0 10px' }}>
            <strong>Last sweep for leftover keys:</strong> {sweepLine(sweep)}
          </p>
          {sweep && sweep.deleted.length > 0 ? (
            <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
              Deleted: {sweep.deleted.map((d) => `${d.alias} (${d.reason === 'derivable' ? 'guessable, of a system that no longer exists' : 'no budget, from the old reconcile'})`).join(', ')}.
            </p>
          ) : null}
          {sweep && sweep.failed.length > 0 ? (
            <p style={{ fontSize: 12, margin: '0 0 10px' }}>Not deleted: {sweep.failed.map((f) => `${f.alias} (${f.error})`).join(', ')}.</p>
          ) : null}

          {data.systems.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>No agent systems yet.</p>
          ) : (
            <>
              {needBuild > 0 ? (
                <p style={{ fontSize: 13, margin: '0 0 8px' }}>{needBuild} system(s) cannot run until they are built: open each one and press Build (Rebuild).</p>
              ) : null}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>System</th><th>Key</th><th>Issued</th><th>Replaced</th><th>Budget and limits</th><th /></tr>
                  </thead>
                  <tbody>
                    {data.systems.map((s) => (
                      <tr key={s.systemId}>
                        <td>{s.name}<div className="muted" style={{ fontSize: 11 }}>{s.systemId}</div>
                          {driftOf.get(s.systemId) ? (
                            <div role="alert" style={{ fontSize: 12, marginTop: 4 }}>
                              <span className="badge err" style={{ fontSize: 11 }}>{DRIFT_LABEL[driftOf.get(s.systemId)!.kind]}</span>{' '}
                              {driftOf.get(s.systemId)!.changes.join('; ')} <span className="muted">(since {when(driftOf.get(s.systemId)!.firstSeenAt)})</span>
                              {driftOf.get(s.systemId)!.action === 'correction-failed' ? <div>Automatic correction failed: {driftOf.get(s.systemId)!.error}</div> : null}
                            </div>
                          ) : null}
                        </td>
                        <td title={s.message ?? ''}>
                          <span className={`badge ${s.state === 'ready' ? 'ok' : 'err'}`} style={{ fontSize: 11 }}>{STATE_LABEL[s.state]}</span>
                        </td>
                        <td>{when(s.createdAt)}</td>
                        <td>{when(s.rotatedAt)}</td>
                        <td style={{ fontSize: 12 }}>{capsLine(s.caps)}</td>
                        <td>
                          {driftOf.get(s.systemId) ? (
                            <button className="btn" onClick={() => act('reapply', s.systemId)} disabled={busy !== ''} title="Put this key back to what the system's definition says. The key value does not change; this is recorded in the audit log.">
                              {busy === `reapply:${s.systemId}` ? <span className="spin" /> : 'Re-apply from the OS'}
                            </button>
                          ) : null}{' '}
                          <button className="btn" onClick={() => act('rotate', s.systemId)} disabled={busy !== ''} title="Issue a new random key and delete the old one at the gateway">
                            {busy === s.systemId ? <span className="spin" /> : s.state === 'ready' ? 'Replace key' : 'Issue key'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      ) : null}
    </section>
  );
}
