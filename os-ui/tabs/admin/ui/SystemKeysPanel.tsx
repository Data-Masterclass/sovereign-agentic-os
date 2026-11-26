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
 *
 * I18N:       converted (wave 2) — texts from `admin.systemKeys.*`. Error text and details from the server
 *             are shown as they are.
 */
'use client';

import { useState } from 'react';
import { useApi } from '@core/ui/useApi';
import { useTranslations, useFormat } from '@core/i18n/client';

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

type T = ReturnType<typeof useTranslations<'admin'>>;
type When = (ms?: number | null) => string;

const STATE_LABEL: Record<KeyRow['state'], `systemKeys.states.${'ready' | 'missing' | 'unreadable' | 'notConfigured' | 'storeUnavailable'}`> = {
  ready: 'systemKeys.states.ready',
  missing: 'systemKeys.states.missing',
  unreadable: 'systemKeys.states.unreadable',
  'not-configured': 'systemKeys.states.notConfigured',
  'store-unavailable': 'systemKeys.states.storeUnavailable',
};

// The exact `toLocaleString()` shape the panel showed before i18n (en: "11/27/2026, 2:05:07 PM"), in the user's language.
const WHEN: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };

function sweepLine(sweep: Sweep | null, t: T, when: When): string {
  if (sweep === null) return t('systemKeys.notRunYet');
  if (sweep.error) return t('systemKeys.sweepError', { when: when(sweep.at), error: sweep.error });
  const args = { when: when(sweep.at), scanned: sweep.scanned, deleted: sweep.deleted.length };
  return sweep.failed.length
    ? t('systemKeys.sweepDoneFailed', { ...args, failed: sweep.failed.length })
    : t('systemKeys.sweepDone', args);
}

function migrationLine(m: Migration | null, t: T, when: When): string {
  if (m === null) return t('systemKeys.notRunYet');
  if (m.error) return t('systemKeys.migrationError', { when: when(m.at), error: m.error });
  const args = { when: when(m.at), scanned: m.scanned, migrated: m.migrated.length, fine: m.alreadyFine };
  const line = m.failed.length
    ? t('systemKeys.migrationDoneFailed', { ...args, failed: m.failed.length })
    : t('systemKeys.migrationDone', args);
  return m.done ? line : `${line} ${t('systemKeys.willRetry')}`;
}

function reconcileLine(r: Reconcile | null | undefined, mode: Payload['reconcileMode'], t: T, when: When): string {
  const min = mode ? Math.round(mode.intervalSeconds / 60) || 1 : 1;
  const how = !mode ? '' : mode.intervalSeconds <= 0
    ? t('systemKeys.checkOff')
    : mode.autoCorrect === 'all' ? t('systemKeys.checkAll', { min })
      : mode.autoCorrect.length ? t('systemKeys.checkSome', { min, list: mode.autoCorrect.join(', ') })
        : t('systemKeys.checkNone', { min });
  const tail = how ? ` ${how}` : '';
  if (!r) return `${t('systemKeys.reconcileNotRun')}${tail}`;
  if (!r.ok) return `${t('systemKeys.reconcileError', { when: when(r.at), error: r.error ?? r.unchecked.map((u) => `${u.systemId}: ${u.error}`).join('; ') })}${tail}`;
  return `${t('systemKeys.reconcileDone', { when: when(r.at), scanned: r.scanned, inSync: r.inSync, differ: r.entries.filter((e) => e.action !== 'corrected').length, notBuilt: r.notBuilt })}${tail}`;
}

const DRIFT_LABEL: Record<DriftEntry['kind'], `systemKeys.drift.${'drift' | 'missing' | 'duplicate' | 'notOurs'}`> = {
  drift: 'systemKeys.drift.drift',
  missing: 'systemKeys.drift.missing',
  duplicate: 'systemKeys.drift.duplicate',
  'not-ours': 'systemKeys.drift.notOurs',
};

function capsLine(caps: KeyRow['caps'], t: T): string {
  if (!caps) return '—';
  // Limits are passed as plain strings so they read exactly as configured (no digit grouping).
  const budget = caps.budgetDuration
    ? t('systemKeys.budgetPer', { amount: String(caps.maxBudget), duration: caps.budgetDuration })
    : t('systemKeys.budgetTotal', { amount: String(caps.maxBudget) });
  return t('systemKeys.caps', { budget, rpm: String(caps.rpmLimit), tpm: String(caps.tpmLimit), parallel: String(caps.maxParallelRequests), models: caps.models.length });
}

export default function SystemKeysPanel() {
  const t = useTranslations('admin');
  const f = useFormat();
  const when: When = (ms) => (ms ? f.dateTime(ms, WHEN) : '—');
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
      const why = body.error ?? body.row?.error ?? t('systemKeys.requestFailedStatus', { status: String(res.status) });
      const id = systemId ?? '';
      if (action === 'reapply') setNote(res.ok ? t('systemKeys.noteReapplied', { id }) : t('systemKeys.noteNotReapplied', { id, why }));
      else if (action === 'rotate') setNote(res.ok ? t('systemKeys.noteReplaced', { id, detail: body.row?.appliedDetail ?? '' }) : t('systemKeys.noteNotReplaced', { id, why }));
      else if (!res.ok) setNote(t('systemKeys.noteMigrationFailed', { why }));
      await reload();
    } catch (e) {
      setNote(t('systemKeys.noteRequestFailed', { error: (e as Error).message }));
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
        <h2 style={{ fontFamily: 'var(--font-head)', fontSize: 16, margin: 0 }}>{t('systemKeys.title')}</h2>
        <button className="btn" onClick={() => act('sweep')} disabled={busy !== ''}>
          {busy === 'sweep' ? <span className="spin" /> : t('systemKeys.moveNow')}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 13, margin: '0 0 10px' }}>
        {t('systemKeys.intro')}
      </p>

      {loading ? <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t('systemKeys.loading')}</p> : null}
      {error ? <p style={{ fontSize: 13, margin: 0 }}>{t('systemKeys.readError', { error })}</p> : null}
      {note ? <p role="status" style={{ fontSize: 13, margin: '0 0 10px' }}>{note}</p> : null}

      {data ? (
        <>
          <p style={{ fontSize: 13, margin: '0 0 10px' }}>
            <strong>{t('systemKeys.migrationLabel')}</strong> {migrationLine(data.migration ?? null, t, when)}
          </p>
          {data.migration && data.migration.failed.length > 0 ? (
            <p style={{ fontSize: 12, margin: '0 0 10px' }}>{t('systemKeys.notMoved', { list: data.migration.failed.map((x) => `${x.alias} (${x.error})`).join(', ') })}</p>
          ) : null}
          <p style={{ fontSize: 13, margin: '0 0 10px' }}>
            <strong>{t('systemKeys.driftLabel')}</strong> {reconcileLine(data.reconcile, data.reconcileMode, t, when)}
          </p>
          <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
            {t('systemKeys.owners')}
          </p>
          <p style={{ fontSize: 13, margin: '0 0 10px' }}>
            <strong>{t('systemKeys.sweepLabel')}</strong> {sweepLine(sweep, t, when)}
          </p>
          {sweep && sweep.deleted.length > 0 ? (
            <p className="muted" style={{ fontSize: 12, margin: '0 0 10px' }}>
              {t('systemKeys.deleted', { list: sweep.deleted.map((d) => `${d.alias} (${d.reason === 'derivable' ? t('systemKeys.reasonDerivable') : t('systemKeys.reasonNoBudget')})`).join(', ') })}
            </p>
          ) : null}
          {sweep && sweep.failed.length > 0 ? (
            <p style={{ fontSize: 12, margin: '0 0 10px' }}>{t('systemKeys.notDeleted', { list: sweep.failed.map((x) => `${x.alias} (${x.error})`).join(', ') })}</p>
          ) : null}

          {data.systems.length === 0 ? (
            <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t('systemKeys.noSystems')}</p>
          ) : (
            <>
              {needBuild > 0 ? (
                <p style={{ fontSize: 13, margin: '0 0 8px' }}>{t('systemKeys.needBuild', { count: needBuild })}</p>
              ) : null}
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr><th>{t('systemKeys.colSystem')}</th><th>{t('systemKeys.colKey')}</th><th>{t('systemKeys.colIssued')}</th><th>{t('systemKeys.colReplaced')}</th><th>{t('systemKeys.colBudget')}</th><th /></tr>
                  </thead>
                  <tbody>
                    {data.systems.map((s) => (
                      <tr key={s.systemId}>
                        <td>{s.name}<div className="muted" style={{ fontSize: 11 }}>{s.systemId}</div>
                          {driftOf.get(s.systemId) ? (
                            <div role="alert" style={{ fontSize: 12, marginTop: 4 }}>
                              <span className="badge err" style={{ fontSize: 11 }}>{t(DRIFT_LABEL[driftOf.get(s.systemId)!.kind])}</span>{' '}
                              {driftOf.get(s.systemId)!.changes.join('; ')} <span className="muted">{t('systemKeys.since', { date: when(driftOf.get(s.systemId)!.firstSeenAt) })}</span>
                              {driftOf.get(s.systemId)!.action === 'correction-failed' ? <div>{t('systemKeys.correctionFailed', { error: driftOf.get(s.systemId)!.error ?? '' })}</div> : null}
                            </div>
                          ) : null}
                        </td>
                        <td title={s.message ?? ''}>
                          <span className={`badge ${s.state === 'ready' ? 'ok' : 'err'}`} style={{ fontSize: 11 }}>{t(STATE_LABEL[s.state])}</span>
                        </td>
                        <td>{when(s.createdAt)}</td>
                        <td>{when(s.rotatedAt)}</td>
                        <td style={{ fontSize: 12 }}>{capsLine(s.caps, t)}</td>
                        <td>
                          {driftOf.get(s.systemId) ? (
                            <button className="btn" onClick={() => act('reapply', s.systemId)} disabled={busy !== ''} title={t('systemKeys.reapplyTitle')}>
                              {busy === `reapply:${s.systemId}` ? <span className="spin" /> : t('systemKeys.reapply')}
                            </button>
                          ) : null}{' '}
                          <button className="btn" onClick={() => act('rotate', s.systemId)} disabled={busy !== ''} title={t('systemKeys.rotateTitle')}>
                            {busy === s.systemId ? <span className="spin" /> : s.state === 'ready' ? t('systemKeys.replaceKey') : t('systemKeys.issueKey')}
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
