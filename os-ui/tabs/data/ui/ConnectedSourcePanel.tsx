/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <ConnectedSourcePanel /> — the SOURCE stage of an adopted (origin:'connected') dataset
 * (lakehouse-import-exposure.md, Phase 2+3). A connected dataset has no Ingest/Refine; it IS
 * an external table — federated LIVE, or a scheduled SYNCED copy. This panel replaces those
 * stages with an HONEST source card:
 *   • LIVE — connection link, source FQN, mode/tier, catalog snapshot freshness, drift/revoked
 *     states, live guardrail notes.
 *   • SYNC — the same identity block plus the SYNC face: mode badge, freshness = LAST
 *     SUCCESSFUL SYNC RUN (real, from sync-runs), next-run schedule, a run-history summary,
 *     and the revocation FREEZE ("copy frozen as of <last successful run>" — the copy is kept
 *     but sync is disabled). Nothing fabricated — every timestamp comes from a real run.
 */

import { useEffect, useState } from 'react';
import { useTranslations, useFormat } from '@core/i18n/client';
import type { Formatters } from '@core/i18n/format';

export type ConnectedInfo = {
  connectionId: string;
  exposureId: string;
  source: { catalog: string; schema: string; table: string };
  mode: 'live' | 'sync';
  tier: 'silver' | 'gold';
  status: 'ok' | 'drifted' | 'source-revoked';
};

type Snapshot = { takenAt: string; status: string } | null;

type SyncRun = {
  id: string;
  startedAt: string;
  finishedAt?: string;
  status: 'ok' | 'error' | 'skipped' | 'running';
  rowsAffected?: number | null;
};
type SyncState = {
  sync: { schedule: { cron: string }; enabled: boolean } | null;
  runs: SyncRun[];
  watermark: string | null;
} | null;

/** Preset crons → the `connectedSource.cadence.*` catalog phrase ("every 15 minutes", …). */
const PRESET_KEYS: Record<string, 'every15' | 'every30' | 'hourly' | 'daily' | 'weekly'> = {
  '*/15 * * * *': 'every15',
  '*/30 * * * *': 'every30',
  '0 * * * *': 'hourly',
  '0 6 * * *': 'daily',
  '0 6 * * 1': 'weekly',
};

/** The full numeric date + time `toLocaleString()` gave (en: "11/27/2026, 10:30:00 AM"), in the user's locale. */
const FULL_DATE_TIME: Intl.DateTimeFormatOptions = { year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' };

function fqnOf(c: ConnectedInfo): string {
  return `${c.source.catalog}.${c.source.schema}.${c.source.table}`;
}

function fmt(iso: string, f: Formatters): string {
  return f.dateTime(iso, FULL_DATE_TIME) || iso;
}

export default function ConnectedSourcePanel({ connected, datasetId }: { connected: ConnectedInfo; datasetId?: string }) {
  const t = useTranslations('data');
  const f = useFormat();
  const [snapshot, setSnapshot] = useState<Snapshot>(null);
  const [connName, setConnName] = useState<string>('');
  const [syncState, setSyncState] = useState<SyncState>(null);

  const isSync = connected.mode === 'sync';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [snapRes, connRes] = await Promise.all([
          fetch(`/api/connections/${connected.connectionId}/snapshot`, { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
          fetch('/api/connections', { cache: 'no-store' }).then((r) => r.json()).catch(() => ({})),
        ]);
        if (cancelled) return;
        setSnapshot((snapRes.snapshot as Snapshot) ?? null);
        const c = ((connRes.connections as Array<{ id: string; name: string }>) ?? []).find((x) => x.id === connected.connectionId);
        if (c) setConnName(c.name);
      } catch { /* the card degrades to "no snapshot yet" — honest */ }
    })();
    return () => { cancelled = true; };
  }, [connected.connectionId]);

  // Sync datasets: pull real run history + schedule (freshness = last successful run).
  useEffect(() => {
    if (!isSync || !datasetId) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/data/datasets/${datasetId}/sync`, { cache: 'no-store' });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setSyncState({ sync: data.sync ?? null, runs: (data.runs as SyncRun[]) ?? [], watermark: data.watermark ?? null });
      } catch { /* the card degrades to "no runs yet" — honest */ }
    })();
    return () => { cancelled = true; };
  }, [isSync, datasetId]);

  const revoked = connected.status === 'source-revoked';
  const drifted = connected.status === 'drifted';

  const runs = syncState?.runs ?? [];
  const lastOk = runs.find((r) => r.status === 'ok') ?? null;
  const cron = syncState?.sync?.schedule.cron ?? '';
  const cadence = cron ? (PRESET_KEYS[cron] ? t(`connectedSource.cadence.${PRESET_KEYS[cron]}`) : t('connectedSource.cadence.custom', { cron })) : '';
  const strong = (c: React.ReactNode) => <strong>{c}</strong>;
  const runStatusText = (s: SyncRun['status']) => t(`connectedSource.runStatus.${s}`);

  return (
    <div style={{ order: 1 }}>
      <div className="section-title" style={{ marginTop: 0 }}>{t('connectedSource.title')}</div>

      {revoked ? (
        isSync ? (
          <div className="passthrough-note" style={{ marginBottom: 12 }}>
            {lastOk
              ? t.rich('connectedSource.frozenAsOf', { date: fmt(lastOk.startedAt, f), strong })
              : t.rich('connectedSource.frozen', { strong })}
          </div>
        ) : (
          <div className="error" style={{ marginBottom: 12 }}>
            {t.rich('connectedSource.revoked', { strong })}
          </div>
        )
      ) : null}

      {drifted && !revoked ? (
        <div className="passthrough-note" style={{ marginBottom: 12 }}>
          {t.rich(isSync ? 'connectedSource.driftedSync' : 'connectedSource.driftedLive', { strong })}
        </div>
      ) : null}

      <div className="card" style={{ padding: 14 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="badge vis-shared">{isSync ? t('connectedSource.badgeSync') : t('connectedSource.badgeLive')}</span>
          <span className="badge muted">{t(`connectedSource.tier.${connected.tier}`)}</span>
          {drifted ? <span className="badge" style={{ background: 'var(--warn, #a86)' }}>{t('connectedSource.badgeDrifted')}</span> : null}
          {revoked ? <span className="badge" style={{ background: 'var(--danger, #a44)' }}>{isSync ? t('connectedSource.badgeFrozen') : t('connectedSource.badgeRevoked')}</span> : null}
        </div>

        <dl style={{ margin: '12px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 13 }}>
          <dt className="muted">{t('connectedSource.connection')}</dt>
          <dd style={{ margin: 0 }}>
            <a href={`/connections?open=${encodeURIComponent(connected.connectionId)}`} className="link">
              {connName || connected.connectionId}
            </a>
          </dd>
          <dt className="muted">{t('connectedSource.sourceTable')}</dt>
          <dd className="mono" style={{ margin: 0 }}>{fqnOf(connected)}</dd>
          <dt className="muted">{t('connectedSource.mode')}</dt>
          <dd style={{ margin: 0 }}>
            {isSync ? t('connectedSource.modeSync') : t('connectedSource.modeLive')}
          </dd>
          <dt className="muted">{t('connectedSource.declaredTier')}</dt>
          <dd style={{ margin: 0 }}>{t(`connectedSource.tier.${connected.tier}`)}</dd>

          {isSync ? (
            <>
              <dt className="muted">{t('connectedSource.freshness')}</dt>
              <dd style={{ margin: 0 }}>
                {lastOk
                  ? typeof lastOk.rowsAffected === 'number'
                    ? t('connectedSource.lastOkRows', { date: fmt(lastOk.startedAt, f), count: lastOk.rowsAffected })
                    : t('connectedSource.lastOk', { date: fmt(lastOk.startedAt, f) })
                  : t('connectedSource.noOk')}
              </dd>
              <dt className="muted">{t('connectedSource.schedule')}</dt>
              <dd style={{ margin: 0 }}>
                {revoked
                  ? t('connectedSource.syncDisabled')
                  : syncState?.sync
                    ? syncState.sync.enabled ? t('connectedSource.runs', { cadence }) : t('connectedSource.scheduleOff', { cadence })
                    : '—'}
              </dd>
              {syncState?.watermark ? (
                <>
                  <dt className="muted">{t('connectedSource.syncedThrough')}</dt>
                  <dd className="mono" style={{ margin: 0, fontSize: 11.5 }}>{syncState.watermark}</dd>
                </>
              ) : null}
            </>
          ) : (
            <>
              <dt className="muted">{t('connectedSource.snapshot')}</dt>
              <dd style={{ margin: 0 }}>
                {snapshot?.takenAt
                  ? snapshot.status
                    ? t('connectedSource.snapshotFromStatus', { date: fmt(snapshot.takenAt, f), status: snapshot.status })
                    : t('connectedSource.snapshotFrom', { date: fmt(snapshot.takenAt, f) })
                  : t('connectedSource.noSnapshot')}
              </dd>
            </>
          )}
        </dl>

        {isSync && runs.length > 0 ? (
          <p className="hint" style={{ marginTop: 12, marginBottom: 0, fontSize: 11.5 }}>
            {t('connectedSource.recentRuns', { count: runs.length, status: runStatusText(runs[0].status), date: fmt(runs[0].startedAt, f) })}
          </p>
        ) : null}

        {!isSync && !revoked ? (
          <p className="hint" style={{ marginTop: 12, marginBottom: 0, fontSize: 11.5 }}>
            {t('connectedSource.guardrails')}
          </p>
        ) : null}
      </div>
    </div>
  );
}
