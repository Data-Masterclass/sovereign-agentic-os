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

const PRESET_LABELS: Record<string, string> = {
  '*/15 * * * *': 'every 15 minutes',
  '*/30 * * * *': 'every 30 minutes',
  '0 * * * *': 'hourly',
  '0 6 * * *': 'daily',
  '0 6 * * 1': 'weekly',
};

function fqnOf(c: ConnectedInfo): string {
  return `${c.source.catalog}.${c.source.schema}.${c.source.table}`;
}

function fmt(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function ConnectedSourcePanel({ connected, datasetId }: { connected: ConnectedInfo; datasetId?: string }) {
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
  const cadence = cron ? (PRESET_LABELS[cron] ?? `on ${cron}`) : '';

  return (
    <div style={{ order: 1 }}>
      <div className="section-title" style={{ marginTop: 0 }}>Source</div>

      {revoked ? (
        isSync ? (
          <div className="passthrough-note" style={{ marginBottom: 12 }}>
            <strong>Copy frozen{lastOk ? ` as of ${fmt(lastOk.startedAt)}` : ''}.</strong> A platform admin
            revoked the exposure this synced copy was adopted from — the sync is disabled and no new
            data will land, but the last-landed copy is kept and stays fully queryable. Re-adopt from
            an active exposure to resume syncing.
          </div>
        ) : (
          <div className="error" style={{ marginBottom: 12 }}>
            <strong>Source revoked by a platform admin.</strong> This dataset was adopted from a
            connection exposure that has since been revoked — no data is shown, and preview / Talk
            are disabled. Re-adopt the table from an active exposure to restore it.
          </div>
        )
      ) : null}

      {drifted && !revoked ? (
        <div className="passthrough-note" style={{ marginBottom: 12 }}>
          <strong>Source drifted.</strong> The catalog snapshot no longer lists this table where it
          was adopted — it may have been renamed or moved. {isSync ? 'The next sync may fail until the source is confirmed;' : 'Reads still run against the last-known FQN;'} confirm the source and re-adopt if it moved.
        </div>
      ) : null}

      <div className="card" style={{ padding: 14 }}>
        <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="badge vis-shared">{isSync ? 'Sync' : 'Live'}</span>
          <span className="badge muted">{connected.tier}</span>
          {drifted ? <span className="badge" style={{ background: 'var(--warn, #a86)' }}>drifted</span> : null}
          {revoked ? <span className="badge" style={{ background: 'var(--danger, #a44)' }}>{isSync ? 'frozen' : 'source revoked'}</span> : null}
        </div>

        <dl style={{ margin: '12px 0 0', display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: 13 }}>
          <dt className="muted">Connection</dt>
          <dd style={{ margin: 0 }}>
            <a href={`/connections?open=${encodeURIComponent(connected.connectionId)}`} className="link">
              {connName || connected.connectionId}
            </a>
          </dd>
          <dt className="muted">Source table</dt>
          <dd className="mono" style={{ margin: 0 }}>{fqnOf(connected)}</dd>
          <dt className="muted">Mode</dt>
          <dd style={{ margin: 0 }}>
            {isSync
              ? 'Sync — a governed copy lands into your domain on a schedule; reads hit the local copy'
              : 'Live (federated) — every read runs straight against the source'}
          </dd>
          <dt className="muted">Declared tier</dt>
          <dd style={{ margin: 0 }}>{connected.tier}</dd>

          {isSync ? (
            <>
              <dt className="muted">Freshness</dt>
              <dd style={{ margin: 0 }}>
                {lastOk ? `last successful sync ${fmt(lastOk.startedAt)}${typeof lastOk.rowsAffected === 'number' ? ` · ${lastOk.rowsAffected} row(s)` : ''}` : 'no successful sync yet'}
              </dd>
              <dt className="muted">Schedule</dt>
              <dd style={{ margin: 0 }}>
                {revoked
                  ? 'sync disabled (copy frozen)'
                  : syncState?.sync
                    ? syncState.sync.enabled ? `runs ${cadence}` : `schedule off (${cadence})`
                    : '—'}
              </dd>
              {syncState?.watermark ? (
                <>
                  <dt className="muted">Synced through</dt>
                  <dd className="mono" style={{ margin: 0, fontSize: 11.5 }}>{syncState.watermark}</dd>
                </>
              ) : null}
            </>
          ) : (
            <>
              <dt className="muted">Snapshot</dt>
              <dd style={{ margin: 0 }}>
                {snapshot?.takenAt
                  ? `snapshot from ${new Date(snapshot.takenAt).toLocaleString()}${snapshot.status ? ` · ${snapshot.status}` : ''}`
                  : 'no snapshot yet'}
              </dd>
            </>
          )}
        </dl>

        {isSync && runs.length > 0 ? (
          <p className="hint" style={{ marginTop: 12, marginBottom: 0, fontSize: 11.5 }}>
            {runs.length} recent run(s) — see the full history in the sync panel. Last:{' '}
            {runs[0].status === 'ok' ? '✓ ok' : runs[0].status === 'error' ? '✗ error' : runs[0].status}
            {' '}at {fmt(runs[0].startedAt)}.
          </p>
        ) : null}

        {!isSync && !revoked ? (
          <p className="hint" style={{ marginTop: 12, marginBottom: 0, fontSize: 11.5 }}>
            Guardrails: preview is bounded to the first rows (LIMIT); statistics are computed on a
            bounded sample and labeled “sampled, approximate”. Define metrics on a synced copy — not
            a live connected dataset.
          </p>
        ) : null}
      </div>
    </div>
  );
}
