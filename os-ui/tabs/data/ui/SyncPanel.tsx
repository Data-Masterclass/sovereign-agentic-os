/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations, useFormat } from '@core/i18n/client';
import type { Formatters } from '@core/i18n/format';
import { isFrequentCron, nextCronRun } from '@tabs/data/lib/sync-next-run';
import { saveScheduleMessageKey, schedulingDisabled, schedulingDisabledNoteKey } from '@tabs/data/lib/sync-schedule-view';
import { kajabiCursorField } from '@tabs/connections/lib/kajabi-resources';

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
  /** Where the read-back came from. `ledger` ⇒ `DATA_PROJECT_GIT` is off ⇒ nothing schedules a
   *  saved cadence at all (B4-8), which the pickers have to say in words (review M-7). */
  source?: 'ledger' | 'dagster';
  /** The next tick Dagster reports; `null` with the flag off, where there is no next run. */
  nextRunAt?: string | null;
  /** "Scheduled sync is not running: <reason>" — set when the sync is enabled but nothing will
   *  fire it (the dataset was left out of the dbt project, it is an external asset Dagster does
   *  not read yet, or the domain's newest commit has not loaded in Dagster). */
  notRunning?: string | null;
};

type DataT = ReturnType<typeof useTranslations<'data'>>;
type PresetId = 'every15' | 'every30' | 'hourly' | 'daily' | 'weekly';

/** `label` is the internal preset id the picker stores (English, never rendered); `id` keys the catalog. */
const PRESETS: { id: PresetId; label: string; cron: string }[] = [
  { id: 'every15', label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { id: 'every30', label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { id: 'hourly', label: 'Hourly', cron: '0 * * * *' },
  { id: 'daily', label: 'Daily', cron: '0 6 * * *' },
  { id: 'weekly', label: 'Weekly', cron: '0 6 * * 1' },
];

/** "Refreshes every 15 minutes · next ≈ 10:30" — the prominent cadence line. */
function cadenceLine(cron: string, t: DataT, f: Formatters): string {
  const id = PRESETS.find((p) => p.cron === cron)?.id;
  const cadence = id ? t(`sync.cadence.${id}`) : t('sync.cadence.custom', { cron });
  const next = nextCronRun(cron, new Date());
  return next ? t('sync.cadence.withNext', { cadence, time: f.date(next, { hour: '2-digit', minute: '2-digit' }) }) : cadence;
}

const MODE_KEYS: Record<SyncConfig['mode'], 'fullRefresh' | 'append' | 'merge'> = {
  'full-refresh': 'fullRefresh',
  append: 'append',
  merge: 'merge',
};

function presetFor(cron: string): string {
  return PRESETS.find((p) => p.cron === cron)?.label ?? 'Custom';
}

/** The picker's stored preset id ('Daily' … 'Custom') in the user's language. */
function presetText(label: string, t: DataT): string {
  const id = PRESETS.find((p) => p.label === label)?.id;
  return id ? t(`sync.presets.${id}`) : t('sync.presets.custom');
}

function fmtTime(iso: string, f: Formatters): string {
  return f.dateTime(iso, { dateStyle: 'medium', timeStyle: 'short' }) || iso;
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
  const t = useTranslations('data');
  const f = useFormat();
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
      if (!res.ok) { setMsg(`✗ ${data.error ?? t('sync.errors.save')}`); return; }
      // Honest about the trigger. `reconcileSyncSchedule` answers `ok: true` in BOTH worlds and
      // puts the difference in `detail` — "Dagster schedules this from the repository" vs
      // "nothing schedules it" — so the detail is shown WHENEVER it is non-empty, not only on a
      // failure (review H-3a). The wording lives in a tested `.ts` helper.
      const saved = saveScheduleMessageKey(data.cron as { ok?: boolean; detail?: string } | undefined);
      setMsg(saved.args ? t(saved.key, saved.args) : t(saved.key));
      await load();
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function run(action?: 'reset') {
    if (busy) return;
    if (action === 'reset' && !window.confirm(t('sync.confirmReset'))) return;
    setBusy(true);
    setMsg('');
    try {
      const res = await fetch(`/api/data/datasets/${datasetId}/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(action ? { action } : {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg(`✗ ${data.error ?? t('sync.errors.sync')}`);
      else if (data.skipped) setMsg(t('sync.skipped', { reason: String(data.reason) }));
      else if (data.run?.status === 'error') setMsg(`✗ ${data.run.error ?? t('sync.errors.sync')}`);
      else setMsg(typeof data.run?.rowsAffected === 'number' ? t('sync.syncedRows', { count: data.run.rowsAffected }) : t('sync.synced'));
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
        {t('sync.title')}
        <span className="hint" style={{ margin: '0 0 0 10px' }}>
          {t.rich('sync.from', { source: `${source.schema}.${source.table}`, mono: (c) => <span className="mono">{c}</span> })}
        </span>
      </div>

      {status.notRunning ? (
        <div className="error" role="status" style={{ marginBottom: 10 }}>
          {status.notRunning}
        </div>
      ) : null}

      {status.quarantined ? (
        status.source === 'dagster' ? (
          <div className="error" style={{ marginBottom: 10 }}>
            {t('sync.pausedDagster', { count: status.consecutiveErrors })}
          </div>
        ) : (
          <div className="error" style={{ marginBottom: 10 }}>
            {t('sync.pausedLedger', { count: status.consecutiveErrors })}
          </div>
        )
      ) : null}

      {canEdit ? (
        <>
          {isKafka ? (
            <p className="hint" style={{ margin: 0 }}>
              {t.rich('sync.kafka', { strong: (c) => <strong>{c}</strong> })}
            </p>
          ) : (
            <>
              <div className="seg">
                {(Object.keys(MODE_KEYS) as SyncConfig['mode'][])
                  .filter((m) => !((isSalesforce || isKajabi) && m === 'merge'))
                  .filter((m) => !(isKajabi && kajabiCursor === null && m !== 'full-refresh'))
                  .map((m) => (
                    <button key={m} className={effMode === m ? 'on' : ''} onClick={() => setMode(m)}>{t(`sync.mode.${MODE_KEYS[m]}`)}</button>
                  ))}
              </div>
              <p className="hint" style={{ margin: '8px 0 0' }}>
                {isSalesforce
                  ? effMode === 'full-refresh'
                    ? t('sync.hint.salesforceFull')
                    : t('sync.hint.salesforceIncremental')
                  : isKajabi
                    ? effMode === 'full-refresh'
                      ? kajabiCursor === null
                        ? t('sync.hint.kajabiFullNoCursor')
                        : t('sync.hint.kajabiFull')
                      : kajabiCursor === 'updated_at'
                        ? t('sync.hint.kajabiUpdated')
                        : t('sync.hint.kajabiCreated')
                    : effMode === 'full-refresh'
                      ? t('sync.hint.full')
                      : effMode === 'append'
                        ? t('sync.hint.append')
                        : t('sync.hint.merge')}
              </p>
            </>
          )}

          {isSalesforce && incremental ? (
            <p className="hint" style={{ margin: '6px 0 0' }}>
              {t.rich('sync.tracking', { column: 'SystemModstamp', mono: (c) => <span className="mono">{c}</span> })}
            </p>
          ) : null}

          {isKajabi && incremental && kajabiCursor ? (
            <p className="hint" style={{ margin: '6px 0 0' }}>
              {t.rich('sync.tracking', { column: kajabiCursor, mono: (c) => <span className="mono">{c}</span> })}
            </p>
          ) : null}

          {incremental && !lockedCursor ? (
            <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
              <input
                type="text"
                list={columns && columns.length > 0 ? `sync-cols-${datasetId}` : undefined}
                value={cursorColumn}
                onChange={(e) => setCursorColumn(e.target.value)}
                placeholder={t('sync.cursorPlaceholder')}
                style={{ flex: '2 1 180px' }}
                autoComplete="off"
              />
              {columns && columns.length > 0 ? (
                <datalist id={`sync-cols-${datasetId}`}>
                  {columns.map((c) => <option key={c} value={c} />)}
                </datalist>
              ) : null}
              <select value={cursorKind} onChange={(e) => setCursorKind(e.target.value as 'timestamp' | 'number')} style={{ flex: '1 1 120px' }} title={t('sync.cursorKindTitle')}>
                <option value="timestamp">{t('sync.kind.timestamp')}</option>
                <option value="number">{t('sync.kind.number')}</option>
              </select>
            </div>
          ) : null}

          {effMode === 'merge' ? (
            <div className="row" style={{ gap: 8, marginTop: 8 }}>
              <input
                type="text"
                value={mergeKeys}
                onChange={(e) => setMergeKeys(e.target.value)}
                placeholder={t('sync.mergeKeysPlaceholder')}
                style={{ flex: '1 1 240px' }}
                autoComplete="off"
              />
            </div>
          ) : null}

          <div className="row" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <select value={preset} onChange={(e) => setPreset(e.target.value)} style={{ flex: '1 1 120px' }}>
              {PRESETS.map((p) => <option key={p.label} value={p.label}>{t(`sync.presets.${p.id}`)}</option>)}
              <option value="Custom">{t('sync.presets.customOption')}</option>
            </select>
            {preset === 'Custom' ? (
              <input
                type="text"
                className="mono"
                value={customCron}
                onChange={(e) => setCustomCron(e.target.value)}
                placeholder={t('sync.cronPlaceholder')}
                style={{ flex: '1 1 140px' }}
                autoComplete="off"
              />
            ) : null}
            <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 13 }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
              {t('sync.enabled')}
            </label>
            <span style={{ flex: 1 }} />
            <button className="btn" onClick={save} disabled={!canSave}>
              {busy ? <span className="spin" /> : t('sync.save')}
            </button>
            {status.sync ? (
              <>
                <button className="btn ghost" onClick={() => run()} disabled={busy}>{t('sync.syncNow')}</button>
                <button className="btn ghost" onClick={() => run('reset')} disabled={busy} title={t('sync.resetTitle')}>
                  {t('sync.reset')}
                </button>
              </>
            ) : null}
          </div>
          {schedulingDisabled(status.source) ? (
            <p className="muted" style={{ margin: '10px 0 0', fontSize: 13 }}>{t(schedulingDisabledNoteKey(status.source)!)}</p>
          ) : enabled ? (
            <p style={{ margin: '10px 0 0', fontSize: 13, fontWeight: 600 }}>{cadenceLine(cron, t, f)}</p>
          ) : null}
          {effMode === 'merge' && isFrequentCron(cron) ? (
            <p className="hint" style={{ margin: '6px 0 0' }}>
              {t('sync.frequentMerge')}
            </p>
          ) : null}
        </>
      ) : status.sync ? (
        <p className="muted" style={{ fontSize: 13, margin: 0 }}>
          {t('sync.readOnly', { mode: t(`sync.mode.${MODE_KEYS[status.sync.mode]}`), preset: presetText(presetFor(status.sync.schedule.cron), t), enabled: String(status.sync.enabled) })}
        </p>
      ) : null}

      {msg ? <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>{msg}</p> : null}

      {status.sync ? (
        <p className="muted" style={{ fontSize: 12.5, margin: '10px 0 0' }}>
          {status.sync.enabled
            ? t.rich('sync.footerOn', { cadence: cadenceLine(status.sync.schedule.cron, t, f), cron: status.sync.schedule.cron, mono: (c) => <span className="mono" style={{ fontSize: 11 }}>{c}</span> })
            : t.rich('sync.footerOff', { cron: status.sync.schedule.cron, mono: (c) => <span className="mono" style={{ fontSize: 11 }}>{c}</span> })}
          {status.watermark ? <> · {t.rich('sync.syncedThrough', { watermark: status.watermark, mono: (c) => <span className="mono" style={{ fontSize: 11 }}>{c}</span> })}</> : null}
        </p>
      ) : null}

      {runs.length > 0 ? (
        <>
          <div className="section-title" style={{ marginTop: 16 }}>{t('sync.history.title')}</div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>{t('sync.history.when')}</th><th>{t('sync.history.mode')}</th><th>{t('sync.history.rows')}</th><th>{t('sync.history.status')}</th><th>{t('sync.history.cursor')}</th></tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtTime(r.startedAt, f)}</td>
                    <td>{r.mode in MODE_KEYS ? t(`sync.mode.${MODE_KEYS[r.mode as SyncConfig['mode']]}`) : r.mode}{r.maintenance ? ` · ${t('sync.history.maintenance')}` : ''}</td>
                    <td>{typeof r.rowsAffected === 'number' ? f.number(r.rowsAffected) : '—'}</td>
                    <td>
                      {t(`sync.runStatus.${r.status === 'ok' || r.status === 'skipped' || r.status === 'running' ? r.status : 'error'}`)}
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
