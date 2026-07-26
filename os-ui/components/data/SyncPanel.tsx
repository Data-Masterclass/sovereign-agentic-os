/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { isFrequentCron, nextCronRun } from '@/lib/data/sync-next-run';
import { kajabiCursorField } from '@/lib/connections/kajabi-resources';

/**
 * "Keep this in sync" — the calm face over SCHEDULED INCREMENTAL SYNC. One panel,
 * two hosts: the warehouse import panel (first-time setup right after an import,
 * which knows the source) and the dataset builder's Ingest stage (view/edit + run
 * history once a sync exists). All complexity — cursors, watermarks, leases,
 * quarantine, Iceberg maintenance — stays in the engine room; the user picks a
 * mode, a column and a cadence.
 *
 * Route contract (shapes declared locally, never imported from routes):
 *   GET  /api/data/datasets/:id/sync → { sync, runs, watermark, quarantined, consecutiveErrors }
 *   PUT  /api/data/datasets/:id/sync { sync } → { sync, cron: { ok, live, detail } }
 *   POST /api/data/datasets/:id/sync { action? } → { run } | { skipped, reason }
 */

type SyncConfig = {
  connectionId: string;
  source: { schema: string; table: string };
  mode: 'full-refresh' | 'append' | 'merge';
  cursor?: { kind: string; column: string };
  mergeKeys?: string[];
  lookbackMinutes?: number;
  schedule: { cron: string };
  enabled: boolean;
};

type SyncRun = {
  id: string;
  startedAt: string;
  status: 'ok' | 'error' | 'skipped' | 'running';
  mode: string;
  rowsAffected?: number | null;
  cursorAfter?: string | null;
  error?: string;
  maintenance?: boolean;
};

type SyncStatus = {
  sync: SyncConfig | null;
  runs: SyncRun[];
  watermark: string | null;
  quarantined: boolean;
  consecutiveErrors: number;
  /** The source connection's platform (kafka ⇒ offsets cursor, append only). */
  platform?: string | null;
};

const PRESETS: { label: string; cron: string }[] = [
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Hourly', cron: '0 * * * *' },
  { label: 'Daily', cron: '0 6 * * *' },
  { label: 'Weekly', cron: '0 6 * * 1' },
];

/** "Refreshes every 15 minutes · next ≈ 10:30" — the prominent cadence line. */
function cadenceLine(cron: string): string {
  const label = PRESETS.find((p) => p.cron === cron)?.label;
  const phrase = label ? label.charAt(0).toLowerCase() + label.slice(1) : `on ${cron}`;
  const next = nextCronRun(cron, new Date());
  const nextTxt = next ? ` · next ≈ ${next.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : '';
  return `Refreshes ${phrase}${nextTxt}`;
}

const MODE_LABELS: Record<SyncConfig['mode'], string> = {
  'full-refresh': 'Full refresh',
  append: 'Add new rows',
  merge: 'Update by key',
};

function presetFor(cron: string): string {
  return PRESETS.find((p) => p.cron === cron)?.label ?? 'Custom';
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default function SyncPanel({
  datasetId,
  canEdit,
  columns,
  setupSource,
}: {
  datasetId: string;
  canEdit: boolean;
  /** Known column names for the cursor/key pickers (optional — free text otherwise). */
  columns?: string[];
  /** First-time setup bootstrap (the import panel knows the source it just copied). */
  setupSource?: { connectionId: string; schema: string; table: string; platform?: string };
}) {
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // Draft config (hydrated from the saved sync, else from the setup source).
  const [mode, setMode] = useState<SyncConfig['mode']>('full-refresh');
  const [cursorColumn, setCursorColumn] = useState('');
  const [cursorKind, setCursorKind] = useState<'timestamp' | 'number'>('timestamp');
  const [mergeKeys, setMergeKeys] = useState('');
  const [preset, setPreset] = useState('Daily');
  const [customCron, setCustomCron] = useState('0 6 * * *');
  const [enabled, setEnabled] = useState(true);

  const hydrate = useCallback((s: SyncStatus) => {
    setStatus(s);
    if (s.sync) {
      setMode(s.sync.mode);
      setCursorColumn(s.sync.cursor?.column ?? '');
      setCursorKind(s.sync.cursor?.kind === 'number' ? 'number' : 'timestamp');
      setMergeKeys((s.sync.mergeKeys ?? []).join(', '));
      setPreset(presetFor(s.sync.schedule.cron));
      setCustomCron(s.sync.schedule.cron);
      setEnabled(s.sync.enabled);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/sync`, { cache: 'no-store' });
      if (res.ok) hydrate((await res.json()) as SyncStatus);
    } catch {
      /* panel stays in its last honest state */
    }
  }, [datasetId, hydrate]);

  useEffect(() => { load(); }, [load]);

  const source = status?.sync
    ? { connectionId: status.sync.connectionId, ...status.sync.source }
    : setupSource ?? null;

  // Nothing to show: no sync configured and no source to set one up from.
  if (!status || (!status.sync && !setupSource)) return null;
  if (!source) return null;

  const cron = preset === 'Custom' ? customCron : (PRESETS.find((p) => p.label === preset)?.cron ?? customCron);
  // Platform-locked panels — the engine room enforces the same rules again:
  //   kafka      → append-only, cursor = per-partition offsets (tracked automatically).
  //   salesforce → API-based pull; cursor locked to SystemModstamp; no merge.
  //   kajabi     → API-based pull; cursor locked to the resource's documented field
  //                (updated_at/created_at from kajabi-resources.ts); resources
  //                without one are honestly full-refresh only; no merge.
  const platformKey = status?.platform ?? setupSource?.platform ?? null;
  const isKafka = platformKey === 'kafka';
  const isSalesforce = platformKey === 'salesforce';
  const isKajabi = platformKey === 'kajabi';
  const kajabiCursor = isKajabi ? kajabiCursorField(source.table) : null;
  const lockedCursor = isKafka || isSalesforce || isKajabi;
  const effMode: SyncConfig['mode'] = isKafka
    ? 'append'
    : isKajabi
      ? kajabiCursor === null
        ? 'full-refresh'
        : mode === 'merge'
          ? 'append'
          : mode
      : isSalesforce && mode === 'merge'
        ? 'append'
        : mode;
  const incremental = effMode !== 'full-refresh';
  const canSave =
    canEdit && !busy && (!incremental || lockedCursor || cursorColumn.trim()) && (effMode !== 'merge' || mergeKeys.trim());

  async function save() {
    if (!canSave) return;
    setBusy(true);
    setMsg('');
    try {
      const sync: SyncConfig = {
        connectionId: source!.connectionId,
        source: { schema: source!.schema, table: source!.table },
        mode: effMode,
        ...(isKafka
          ? { cursor: { kind: 'kafka-offsets', column: '_partition_offset' } }
          : isSalesforce && incremental
            ? { cursor: { kind: 'timestamp', column: 'SystemModstamp' } }
            : isKajabi && incremental && kajabiCursor
              ? { cursor: { kind: 'timestamp', column: kajabiCursor } }
              : incremental
                ? { cursor: { kind: cursorKind, column: cursorColumn.trim() } }
                : {}),
        ...(effMode === 'merge' ? { mergeKeys: mergeKeys.split(',').map((k) => k.trim()).filter(Boolean) } : {}),
        schedule: { cron },
        enabled,
      };
      const res = await fetch(`/api/data/datasets/${datasetId}/sync`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sync }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { setMsg(`✗ ${data.error ?? 'Could not save the sync'}`); return; }
      // Honest about the trigger: saved is saved, but a CronJob that could not be
      // provisioned must not be presented as live.
      const cronOut = data.cron as { ok?: boolean; live?: boolean; detail?: string } | undefined;
      setMsg(cronOut && !cronOut.ok ? `Saved — but: ${cronOut.detail ?? 'the schedule trigger could not be provisioned.'}` : '✓ Saved');
      await load();
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function run(action?: 'reset') {
    if (busy) return;
    if (action === 'reset' && !window.confirm('Reset & full re-sync? This replaces the copy and restarts the cursor from now.')) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action ? { action } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg(`✗ ${data.error ?? 'Sync failed'}`);
      else if (data.skipped) setMsg(`Skipped — ${data.reason}`);
      else if (data.run?.status === 'error') setMsg(`✗ ${data.run.error ?? 'Sync failed'}`);
      else setMsg(`✓ Synced${typeof data.run?.rowsAffected === 'number' ? ` — ${data.run.rowsAffected} row(s)` : ''}`);
      await load();
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  const runs = status.runs ?? [];

  return (
    <div className="guided-panel" style={{ marginTop: 16 }}>
      <div className="section-title" style={{ marginTop: 0 }}>
        Keep this in sync
        <span className="hint" style={{ margin: '0 0 0 10px' }}>
          from <span className="mono">{source.schema}.{source.table}</span>
        </span>
      </div>

      {status.quarantined ? (
        <div className="error" style={{ marginBottom: 10 }}>
          Paused after {status.consecutiveErrors} consecutive failures — fix the source, then press
          “Sync now” to resume (or “Reset &amp; full re-sync” to start over).
        </div>
      ) : null}

      {canEdit ? (
        <>
          {isKafka ? (
            <p className="hint" style={{ margin: 0 }}>
              Streaming source — new messages are <strong>appended</strong>, tracked by Kafka
              partition offsets (no cursor column to pick). Full refresh and update-by-key are not
              available for streams; de-duplicate downstream if producers retry.
            </p>
          ) : (
            <>
              <div className="seg">
                {(Object.keys(MODE_LABELS) as SyncConfig['mode'][])
                  .filter((m) => !((isSalesforce || isKajabi) && m === 'merge'))
                  .filter((m) => !(isKajabi && kajabiCursor === null && m !== 'full-refresh'))
                  .map((m) => (
                    <button key={m} className={effMode === m ? 'on' : ''} onClick={() => setMode(m)}>{MODE_LABELS[m]}</button>
                  ))}
              </div>
              <p className="hint" style={{ margin: '8px 0 0' }}>
                {isSalesforce
                  ? effMode === 'full-refresh'
                    ? 'Re-pulls every record over the Salesforce API each run — API-quota heavy; best for small objects.'
                    : 'Pulls only records modified since the last sync (SystemModstamp) over the Salesforce API. Deletes are not detected (v1).'
                  : isKajabi
                    ? effMode === 'full-refresh'
                      ? kajabiCursor === null
                        ? 'Re-pulls every record over the Kajabi API each run — this resource documents no timestamp cursor, so full refresh is the only honest mode.'
                        : 'Re-pulls every record over the Kajabi API each run — best for small resources.'
                      : kajabiCursor === 'updated_at'
                        ? 'Pulls only records updated since the last sync (updated_at) over the Kajabi API. Updated records re-append — de-duplicate by id downstream; deletes are not detected.'
                        : 'Pulls only records CREATED since the last sync (created_at) — Kajabi documents no updated-at cursor for this resource, so edits to existing records are NOT picked up (run a full refresh to capture them). Deletes are not detected.'
                    : effMode === 'full-refresh'
                      ? 'Re-copies the whole table each run. Simple and exact — best for small tables.'
                      : effMode === 'append'
                        ? 'Adds only rows newer than the last sync (may re-deliver late rows — exact-once needs "Update by key").'
                        : 'Upserts changed rows by key. Best on a daily-ish cadence.'}
              </p>
            </>
          )}

          {isSalesforce && incremental ? (
            <p className="hint" style={{ margin: '6px 0 0' }}>
              Change tracking uses <span className="mono">SystemModstamp</span> — set automatically, nothing to pick.
            </p>
          ) : null}

          {isKajabi && incremental && kajabiCursor ? (
            <p className="hint" style={{ margin: '6px 0 0' }}>
              Change tracking uses <span className="mono">{kajabiCursor}</span> — set automatically, nothing to pick.
            </p>
          ) : null}

          {incremental && !lockedCursor ? (
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <input
                type="text"
                list={columns && columns.length > 0 ? `sync-cols-${datasetId}` : undefined}
                value={cursorColumn}
                onChange={(e) => setCursorColumn(e.target.value)}
                placeholder="New-rows column (e.g. updated_at)"
                style={{ flex: '2 1 180px' }}
                autoComplete="off"
              />
              {columns && columns.length > 0 ? (
                <datalist id={`sync-cols-${datasetId}`}>
                  {columns.map((c) => <option key={c} value={c} />)}
                </datalist>
              ) : null}
              <select value={cursorKind} onChange={(e) => setCursorKind(e.target.value as 'timestamp' | 'number')} style={{ flex: '1 1 120px' }} title="What kind of column is it?">
                <option value="timestamp">Date / time</option>
                <option value="number">Number (id)</option>
              </select>
            </div>
          ) : null}

          {effMode === 'merge' ? (
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <input
                type="text"
                value={mergeKeys}
                onChange={(e) => setMergeKeys(e.target.value)}
                placeholder="Key column(s), comma-separated (e.g. id)"
                style={{ flex: '1 1 240px' }}
                autoComplete="off"
              />
            </div>
          ) : null}

          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={preset} onChange={(e) => setPreset(e.target.value)} style={{ flex: '1 1 120px' }}>
              {PRESETS.map((p) => <option key={p.label} value={p.label}>{p.label}</option>)}
              <option value="Custom">Custom…</option>
            </select>
            {preset === 'Custom' ? (
              <input
                type="text"
                className="mono"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder='cron, e.g. "0 6 * * *"'
                style={{ flex: '1 1 140px' }}
                autoComplete="off"
              />
            ) : null}
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              Enabled
            </label>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={save} disabled={!canSave}>
              {busy ? <span className="spin" /> : 'Save schedule'}
            </button>
            {status.sync ? (
              <>
                <button className="btn ghost" onClick={() => run()} disabled={busy}>Sync now</button>
                <button className="btn ghost" onClick={() => run('reset')} disabled={busy} title="Replace the copy and restart the cursor from now">
                  Reset &amp; full re-sync
                </button>
              </>
            ) : null}
          </div>
          {enabled ? (
            <p style={{ margin: '10px 0 0', fontSize: 13, fontWeight: 600 }}>{cadenceLine(cron)}</p>
          ) : null}
          {effMode === 'merge' && isFrequentCron(cron) ? (
            <p className="hint" style={{ margin: '6px 0 0' }}>
              At this cadence, frequent merges accumulate delete files that slow reads over time.
              &ldquo;Add new rows&rdquo; is recommended for schedules of 30 minutes or less — de-duplicate downstream.
            </p>
          ) : null}
        </>
      ) : status.sync ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          {MODE_LABELS[status.sync.mode]} · {presetFor(status.sync.schedule.cron)} ·{' '}
          {status.sync.enabled ? 'enabled' : 'off'}
        </p>
      ) : null}

      {msg ? <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>{msg}</p> : null}

      {status.sync ? (
        <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
          {status.sync.enabled ? `${cadenceLine(status.sync.schedule.cron)} ` : 'Schedule off '}
          <span className="mono" style={{ fontSize: 11 }}>{status.sync.schedule.cron}</span>
          {status.watermark ? <> · synced through <span className="mono" style={{ fontSize: 11 }}>{status.watermark}</span></> : null}
        </p>
      ) : null}

      {runs.length > 0 ? (
        <>
          <div className="section-title" style={{ marginTop: 16 }}>Sync history</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>When</th><th>Mode</th><th>Rows</th><th>Status</th><th>Cursor</th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.startedAt)}</td>
                    <td>{MODE_LABELS[r.mode as SyncConfig['mode']] ?? r.mode}{r.maintenance ? ' · maintenance' : ''}</td>
                    <td>{typeof r.rowsAffected === 'number' ? r.rowsAffected : '—'}</td>
                    <td>
                      {r.status === 'ok' ? '✓ ok' : r.status === 'skipped' ? '– skipped' : r.status === 'running' ? '… running' : '✗ error'}
                      {r.error ? <span className="muted" style={{ fontSize: 12 }}> — {r.error}</span> : null}
                    </td>
                    <td className="mono" style={{ fontSize: 11 }}>{r.cursorAfter ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </div>
  );
}
