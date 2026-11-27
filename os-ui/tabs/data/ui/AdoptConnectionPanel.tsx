/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <AdoptConnectionPanel /> — the "From a connection" adopt flow (lakehouse-import-exposure.md,
 * Phase 2+3). A domain admin browses the tables exposed to their domain(s), grouped
 * connection → exposure set, picks one, names the dataset (defaults to the table), writes a
 * REQUIRED short description, and adopts it. The created dataset is born at Domain tier with
 * `origin:'connected'`.
 *
 * TWO adopt modes (the exposure decides):
 *   • LIVE — reads federate straight through the source FQN.
 *   • SYNC — a scheduled governed COPY lands into the domain schema at the declared tier.
 *     The dialog shows sync setup prefilled from the exposure's `syncDefaults` in the
 *     SyncPanel vocabulary; Simple keeps it minimal (defaults + schedule), Developer exposes
 *     the full config (mode, cursor, keys). Full-refresh of a large table is warned honestly
 *     (the 15 s governed-statement ceiling) and steered to a cursor.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from '@core/i18n/client';
import CatalogBrowser, { keyOf, type TableRef, type CatalogClassification } from '@tabs/connections/ui/CatalogBrowser';
import { SCHEDULING_OFF_NOTE_KEY } from '@tabs/data/lib/sync-schedule-view';

type EntityCursor = { incremental: boolean; column: string | null; chip: string; note: string };
type ExposedTable = { schema: string; table: string; cursor?: EntityCursor };
type ExposedSyncDefaults = { schedule?: string; fullRefresh?: boolean };
type ExposedExposure = {
  exposureId: string;
  name: string;
  mode: 'live' | 'sync';
  tier: 'silver' | 'gold';
  adoptable: boolean;
  deferredReason?: string;
  domains: string[];
  tables: ExposedTable[];
  syncDefaults?: ExposedSyncDefaults;
  /** Per-entity agent actions (Phase 3, flag-gated) + admin write-approval flag. */
  actions?: Record<string, { read?: boolean; search?: boolean; create?: boolean; update?: boolean }>;
  writeApproved?: boolean;
  note?: string;
};

type SyncMode = 'full-refresh' | 'append' | 'merge';
/** `id` keys the shared `sync.presets.*` catalog labels (the same words the SyncPanel shows). */
const SYNC_PRESETS: { id: 'every15' | 'every30' | 'hourly' | 'daily' | 'weekly'; cron: string }[] = [
  { id: 'every15', cron: '*/15 * * * *' },
  { id: 'every30', cron: '*/30 * * * *' },
  { id: 'hourly', cron: '0 * * * *' },
  { id: 'daily', cron: '0 6 * * *' },
  { id: 'weekly', cron: '0 6 * * 1' },
];
const SYNC_MODE_KEYS: Record<SyncMode, 'fullRefresh' | 'append' | 'merge'> = {
  'full-refresh': 'fullRefresh',
  append: 'append',
  merge: 'merge',
};
type ExposedConnection = {
  connectionId: string;
  connectionName: string;
  catalog: string | null;
  platform: string;
  operational?: boolean;
  exposures: ExposedExposure[];
};

type Pick = { exposure: ExposedExposure; connection: ExposedConnection; table: ExposedTable };

export default function AdoptConnectionPanel({
  onClose,
  onAdopted,
}: {
  onClose: () => void;
  onAdopted: (datasetId: string) => void;
}) {
  const t = useTranslations('data');
  const tc = useTranslations('common');
  const [connections, setConnections] = useState<ExposedConnection[] | null>(null);
  const [err, setErr] = useState('');
  // The AI folder organization per connection (Phase D) — the SAME classification GET the
  // platform admin's Organize stage reads, so a domain admin sees the same folders + AI labels
  // (corrections stay admin-side: readOnlyCategories). Absent → the browser falls back to schema.
  const [classifications, setClassifications] = useState<Record<string, CatalogClassification | undefined>>({});
  const [search, setSearch] = useState('');
  const [pick, setPick] = useState<Pick | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  // Sync-mode config (only used when the picked exposure is sync). Prefilled from the
  // exposure's syncDefaults on pick; Developer reveals the full config.
  const [developer, setDeveloper] = useState(false);
  const [syncMode, setSyncMode] = useState<SyncMode>('full-refresh');
  const [cursorColumn, setCursorColumn] = useState('');
  const [cursorKind, setCursorKind] = useState<'timestamp' | 'number'>('timestamp');
  const [mergeKeys, setMergeKeys] = useState('');
  const [cron, setCron] = useState('0 6 * * *');
  /** `DATA_PROJECT_GIT` off ⇒ a saved cadence is never triggered (B4-8); the picker says it. */
  const [schedulingOff, setSchedulingOff] = useState(false);
  // Action-adoption (Phase 3): the per-pick message after adopting an exposure's actions.
  const [actionMsg, setActionMsg] = useState('');

  /** Adopt ALL of the picked exposure's action-bearing entities into the caller's granted
   *  domain for this exposure — the domain consent step that arms the domain's agents. */
  const adoptActions = useCallback(async () => {
    if (!pick) return;
    const domain = pick.exposure.domains[0];
    const entities = Object.keys(pick.exposure.actions ?? {});
    if (!domain || entities.length === 0) return;
    setActionMsg('');
    try {
      const res = await fetch(`/api/connections/${pick.connection.connectionId}/action-adoptions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exposureId: pick.exposure.exposureId, domain, entities }),
      });
      const data = await res.json();
      setActionMsg(res.ok ? t('adopt.actionsAdopted', { count: entities.length, domain }) : `✗ ${data.error ?? t('adopt.errors.adoption')}`);
    } catch (e) {
      setActionMsg(`✗ ${(e as Error).message}`);
    }
  }, [pick, t]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/data/exposed-tables', { cache: 'no-store' });
        const data = await res.json();
        if (!res.ok) { setErr(data.error ?? t('adopt.errors.load')); return; }
        const conns = (data.connections as ExposedConnection[]) ?? [];
        setConnections(conns);
        // Review M-7: the cadence picker below must say so when nothing will run the cadence.
        setSchedulingOff(data.scheduling === 'off');
        // Pull the classification per connection (best-effort; a missing one just falls back
        // to schema grouping — never blocks adoption). The GET is domain-visible read-only.
        for (const c of conns) {
          fetch(`/api/connections/${c.connectionId}/classification`, { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : null))
            .then((d) => {
              const cls = d?.classification as { taxonomy?: unknown; placements?: unknown; seed?: unknown; lastRunDetail?: string } | undefined;
              if (cls && cls.seed && Array.isArray(cls.taxonomy)) {
                setClassifications((prev) => ({
                  ...prev,
                  [c.connectionId]: { taxonomy: cls.taxonomy as CatalogClassification['taxonomy'], placements: (cls.placements as CatalogClassification['placements']) ?? {}, lastRunDetail: cls.lastRunDetail },
                }));
              }
            })
            .catch(() => {});
        }
      } catch (e) { setErr((e as Error).message); }
    })();
  }, [t]);

  const choose = useCallback((connection: ExposedConnection, exposure: ExposedExposure, table: ExposedTable) => {
    setPick({ connection, exposure, table });
    setName(table.table);
    setDescription('');
    setErr('');
    // Prefill sync config from the exposure's declared defaults (SyncPanel vocabulary).
    if (exposure.mode === 'sync') {
      setDeveloper(false);
      // Operational entities: the cursor is registry-locked (never the caller's to type).
      // A full-refresh-only entity is pinned to full-refresh; a cursor-bearing one prefills
      // 'append' with the registry cursor column (still editable to full refresh).
      if (table.cursor) {
        const inc = table.cursor.incremental && !!table.cursor.column;
        setSyncMode(inc ? 'append' : 'full-refresh');
        setCursorColumn(inc ? (table.cursor.column as string) : '');
      } else {
        setSyncMode(exposure.syncDefaults?.fullRefresh === false ? 'append' : 'full-refresh');
        setCursorColumn('');
      }
      setCursorKind('timestamp');
      setMergeKeys('');
      setCron(exposure.syncDefaults?.schedule ?? '0 6 * * *');
    }
  }, []);

  const adopt = useCallback(async () => {
    if (!pick) return;
    if (!description.trim()) { setErr(t('adopt.errors.description')); return; }
    const isSync = pick.exposure.mode === 'sync';
    if (isSync && syncMode !== 'full-refresh' && !cursorColumn.trim()) {
      setErr(t('adopt.errors.cursor')); return;
    }
    if (isSync && syncMode === 'merge' && !mergeKeys.trim()) {
      setErr(t('adopt.errors.mergeKeys')); return;
    }
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/data/adopt', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          exposureId: pick.exposure.exposureId,
          schema: pick.table.schema,
          table: pick.table.table,
          name: name.trim() || pick.table.table,
          description: description.trim(),
          ...(isSync ? {
            sync: {
              mode: syncMode,
              ...(syncMode !== 'full-refresh' ? { cursor: { kind: cursorKind, column: cursorColumn.trim() } } : {}),
              ...(syncMode === 'merge' ? { mergeKeys: mergeKeys.split(',').map((k) => k.trim()).filter(Boolean) } : {}),
              schedule: { cron },
              enabled: true,
            },
          } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? t('adopt.errors.adoption')); return; }
      onAdopted(data.dataset.id);
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  }, [pick, name, description, syncMode, cursorColumn, cursorKind, mergeKeys, cron, onAdopted, t]);

  const empty = connections !== null && connections.length === 0;

  const total = useMemo(
    () => (connections ?? []).reduce((n, c) => n + c.exposures.reduce((m, e) => m + e.tables.length, 0), 0),
    [connections],
  );

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row" style={{ gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <strong>{t('adopt.title')}</strong>
        <button className="btn ghost sm" onClick={onClose}>{t('adopt.close')}</button>
      </div>
      <p className="hint" style={{ marginTop: 8 }}>
        {t('adopt.intro')}
      </p>

      {err ? <div className="error" style={{ marginTop: 10 }}>{err}</div> : null}

      {connections === null ? (
        <div className="stub-page" style={{ marginTop: 12 }}>{t('adopt.loading')}</div>
      ) : empty ? (
        <div className="stub-page" style={{ marginTop: 12 }}>
          {t('adopt.empty')}
        </div>
      ) : !pick ? (
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div className="row" style={{ gap: 10, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <p className="hint" style={{ margin: 0 }}>{t('adopt.available', { tables: total, connections: connections.length })}</p>
            <input
              type="text" value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder={t('adopt.searchPlaceholder')} style={{ width: 220, maxWidth: '100%' }}
            />
          </div>
          {connections.map((c) => (
            <AdoptConnectionGroup
              key={c.connectionId}
              connection={c}
              classification={classifications[c.connectionId]}
              search={search}
              onChoose={choose}
            />
          ))}
        </div>
      ) : (
        <div style={{ marginTop: 12 }} className="guided-panel">
          <div className="row" style={{ gap: 10, alignItems: 'center', marginBottom: 8 }}>
            <button className="btn ghost sm" onClick={() => setPick(null)}>{t('adopt.back')}</button>
            <span className="mono" style={{ fontSize: 12 }}>
              {pick.connection.catalog ? `${pick.connection.catalog}.` : ''}{pick.table.schema}.{pick.table.table}
            </span>
            <span className="badge vis-shared">{pick.exposure.mode === 'sync' ? t('adopt.badgeSync') : t('adopt.badgeLive')}</span>
            <span className="badge muted">{t(`adopt.tier.${pick.exposure.tier}`)}</span>
            {pick.table.cursor ? (
              <span className="badge muted" title={pick.table.cursor.note}>{pick.table.cursor.chip}</span>
            ) : null}
          </div>
          <label className="hint" style={{ fontSize: 11.5 }}>{t('adopt.nameLabel')}</label>
          <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: '100%', maxWidth: 420, marginBottom: 8 }} />
          <label className="hint" style={{ fontSize: 11.5 }}>{t('adopt.descriptionLabel')} <span style={{ color: 'var(--danger, #d64545)' }}>*</span></label>
          <textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('adopt.descriptionPlaceholder')}
            style={{ width: '100%', maxWidth: 420, marginBottom: 10 }}
          />

          {pick.exposure.mode === 'sync' ? (
            <div className="guided-panel" style={{ marginBottom: 10, background: 'transparent' }}>
              <div className="row" style={{ gap: 8, alignItems: 'center', justifyContent: 'space-between' }}>
                <strong style={{ fontSize: 12.5 }}>{t('adopt.syncTitle')}</strong>
                <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 11.5 }}>
                  <input type="checkbox" checked={developer} onChange={(e) => setDeveloper(e.target.checked)} />
                  {t('adopt.developer')}
                </label>
              </div>
              <p className="hint" style={{ margin: '4px 0 8px' }}>
                {t('adopt.syncHint')}
              </p>

              {developer ? (
                <>
                  {(() => {
                    const cur = pick.table.cursor;
                    // Operational entities: modes are what the REGISTRY says the entity
                    // supports — merge is never available (api-batch); a full-refresh-only
                    // entity offers full refresh alone. The cursor column is registry-locked.
                    const opModes: SyncMode[] | null = cur
                      ? cur.incremental && cur.column
                        ? ['full-refresh', 'append']
                        : ['full-refresh']
                      : null;
                    const modes = opModes ?? (Object.keys(SYNC_MODE_KEYS) as SyncMode[]);
                    return (
                      <div className="seg" style={{ marginBottom: 6 }}>
                        {modes.map((m) => (
                          <button key={m} className={syncMode === m ? 'on' : ''} onClick={() => setSyncMode(m)}>{t(`sync.mode.${SYNC_MODE_KEYS[m]}`)}</button>
                        ))}
                      </div>
                    );
                  })()}
                  {syncMode !== 'full-refresh' && pick.table.cursor ? (
                    <p className="hint" style={{ margin: '0 0 6px', fontSize: 11.5 }}>
                      {t.rich('adopt.trackingAuto', { column: pick.table.cursor.column ?? '', mono: (c) => <span className="mono">{c}</span> })}
                    </p>
                  ) : syncMode !== 'full-refresh' ? (
                    <div className="row" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <input
                        type="text"
                        value={cursorColumn}
                        onChange={(e) => setCursorColumn(e.target.value)}
                        placeholder={t('sync.cursorPlaceholder')}
                        style={{ flex: '2 1 180px' }}
                        autoComplete="off"
                      />
                      <select value={cursorKind} onChange={(e) => setCursorKind(e.target.value as 'timestamp' | 'number')} style={{ flex: '1 1 120px' }}>
                        <option value="timestamp">{t('sync.kind.timestamp')}</option>
                        <option value="number">{t('sync.kind.number')}</option>
                      </select>
                    </div>
                  ) : null}
                  {syncMode === 'merge' && !pick.table.cursor ? (
                    <input
                      type="text"
                      value={mergeKeys}
                      onChange={(e) => setMergeKeys(e.target.value)}
                      placeholder={t('sync.mergeKeysPlaceholder')}
                      style={{ width: '100%', maxWidth: 420, marginBottom: 6 }}
                      autoComplete="off"
                    />
                  ) : null}
                </>
              ) : (
                <p className="hint" style={{ margin: '0 0 6px' }}>
                  {t('adopt.defaults', { mode: syncMode === 'append' || syncMode === 'merge' ? syncMode : 'full' })}
                </p>
              )}

              <label className="hint" style={{ fontSize: 11.5 }}>{t('adopt.scheduleLabel')}</label>
              <select value={cron} onChange={(e) => setCron(e.target.value)} style={{ width: '100%', maxWidth: 420, display: 'block', marginBottom: 4 }}>
                {SYNC_PRESETS.map((p) => <option key={p.cron} value={p.cron}>{t(`sync.presets.${p.id}`)}</option>)}
                {SYNC_PRESETS.every((p) => p.cron !== cron) ? <option value={cron}>{t('adopt.customCron', { cron })}</option> : null}
              </select>
              {schedulingOff ? (
                <p className="hint" style={{ margin: '0 0 6px' }}>{t(SCHEDULING_OFF_NOTE_KEY)}</p>
              ) : null}

              {syncMode === 'full-refresh' ? (
                <p className="hint" style={{ margin: '6px 0 0', color: 'var(--warn, #a86)' }}>
                  {t('adopt.fullRefreshWarn')}
                </p>
              ) : null}
            </div>
          ) : null}

          {pick.exposure.actions && Object.keys(pick.exposure.actions).length > 0 ? (
            <div className="card" style={{ marginBottom: 8 }}>
              <div className="comp-label" style={{ margin: 0 }}>{t('adopt.actionsTitle')}</div>
              <p className="hint" style={{ fontSize: 12, marginTop: 4 }}>
                {t.rich(pick.exposure.writeApproved ? 'adopt.actionsBody' : 'adopt.actionsBodyPending', {
                  entities: Object.keys(pick.exposure.actions).join(', '),
                  strong: (c) => <strong>{c}</strong>,
                })}
              </p>
              <button className="btn ghost sm" onClick={adoptActions}>
                {pick.exposure.domains[0] ? t('adopt.adoptActionsFor', { domain: pick.exposure.domains[0] }) : t('adopt.adoptActionsYourDomain')}
              </button>
              {actionMsg ? <p className={actionMsg.startsWith('✗') ? 'error' : 'answer'} style={{ fontSize: 12, marginTop: 6 }}>{actionMsg}</p> : null}
            </div>
          ) : null}

          <div className="row" style={{ gap: 8 }}>
            <button className="btn" onClick={adopt} disabled={busy || !description.trim()}>
              {busy ? <span className="spin" /> : pick.exposure.mode === 'sync' ? t('adopt.adoptSync') : t('adopt.adoptLive')}
            </button>
            <button className="btn ghost" onClick={() => setPick(null)} disabled={busy}>{tc('actions.cancel')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * One connection's exposed tables, browsed through the SHARED CatalogBrowser (Phase D). It
 * shows the SAME AI folders + labels the platform admin's Organize stage shows
 * (`readOnlyCategories`: no folder checkboxes, no corrections here — those stay admin-side),
 * falling back to schema grouping when this connection has no classification. Each table row
 * carries an "Adopt" affordance (`renderRowExtras`) that opens the unchanged adopt dialog,
 * carrying the exposure that grants it (mode/tier). A table exposed by several sets adopts
 * through the first (its tables/mode/tier are identical for the pick).
 */
function AdoptConnectionGroup({
  connection, classification, search, onChoose,
}: {
  connection: ExposedConnection;
  classification?: CatalogClassification;
  search: string;
  onChoose: (c: ExposedConnection, e: ExposedExposure, t: ExposedTable) => void;
}) {
  // Union the connection's exposed tables (dedup by key) + map each key → the exposure that
  // grants it, so the row's Adopt button knows the mode/tier to pin.
  const { tables, byKey } = useMemo(() => {
    const byKey = new Map<string, { exposure: ExposedExposure; table: ExposedTable }>();
    for (const e of connection.exposures) {
      for (const t of e.tables) {
        const k = `${t.schema}.${t.table}`;
        if (!byKey.has(k)) byKey.set(k, { exposure: e, table: t });
      }
    }
    const tables: TableRef[] = [...byKey.values()].map(({ table }) => ({ schema: table.schema, table: table.table }));
    return { tables, byKey };
  }, [connection]);

  const noSelection = useMemo(() => new Set<string>(), []);
  const tr = useTranslations('data');

  return (
    <div className="guided-panel">
      <div className="section-title" style={{ marginTop: 0 }}>
        {connection.connectionName} <span className="muted mono" style={{ fontSize: 12, fontWeight: 400 }}>· {connection.catalog}</span>
      </div>
      <CatalogBrowser
        connectionId={connection.connectionId}
        tables={tables}
        classification={classification}
        selection={noSelection}
        onSelection={() => {}}
        mode="category"
        search={search}
        readOnlyCategories
        renderRowExtras={(t) => {
          const hit = byKey.get(keyOf(t));
          if (!hit) return null;
          const { exposure } = hit;
          return (
            <span className="row" style={{ gap: 6, alignItems: 'center' }}>
              <span className="badge muted" style={{ fontSize: 10 }}>{tr(exposure.mode === 'sync' ? 'adopt.rowBadgeSync' : 'adopt.rowBadgeLive', { tier: tr(`adopt.tier.${exposure.tier}`) })}</span>
              <button
                type="button"
                className="btn ghost sm"
                disabled={!exposure.adoptable}
                title={exposure.adoptable ? tr('adopt.adoptTitle', { table: `${t.schema}.${t.table}` }) : exposure.deferredReason}
                onClick={() => onChoose(connection, exposure, hit.table)}
              >
                {tr('adopt.adopt')}
              </button>
            </span>
          );
        }}
      />
    </div>
  );
}
