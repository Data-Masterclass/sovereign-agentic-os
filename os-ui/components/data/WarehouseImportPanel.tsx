/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Warehouse browse + import — the reusable "complexity hidden" pieces that turn a
 * registered warehouse connection into a normal governed dataset.
 *
 * Two exports:
 *   - {@link WarehouseBrowser}: pick a schema → pick a table. Honest about Fabric
 *     (`notDiscoverable`): it drops to a manual `schema` / `table` input so a user
 *     can still import an OneLake path they know. Reused by the connection card
 *     (Browse) and the import panel (Import from warehouse).
 *   - {@link WarehouseImportPanel}: the Data-tab affordance — choose a registered
 *     warehouse connection, browse, name the target + pick a domain, Import. The
 *     federated table lands as `iceberg.<domain>.<name>` and we hand the caller a
 *     link into the Data tab.
 *
 * The raw Trino catalog / properties are NEVER shown: a user sees Browse → Import.
 * Route contracts (the backend agent owns the routes; shapes are asserted here):
 *   POST /api/connections/:id/discover  { schema? } →
 *     { ok, schemas: string[], tables: string[], schema: string|null, detail }
 *     (Fabric/OneLake: ok:false + detail — treated as "not discoverable").
 *   POST /api/connections/:id/import    { schema, table, name, targetDomain } →
 *     { ok, target, rowsAffected } | { error }
 */

// ---- Shared response shapes (declared locally — never imported from routes) ----

export type DiscoverResult = {
  ok: boolean;
  schemas: string[];
  tables: string[];
  schema: string | null;
  detail?: string;
};

export type ImportResult = { ok?: boolean; target?: string; rowsAffected?: number | null; error?: string };

/** A registered warehouse connection the user can browse/import from. */
export type WarehouseConn = { id: string; name: string; domain: string; catalog: string; platform: string };

/** The source a browse resolves to — either picked from discovery or typed manually. */
export type BrowseSelection = { schema: string; table: string };

async function postJSON(path: string, body?: unknown): Promise<{ ok: boolean; data: Record<string, unknown> }> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, data };
}

// ---- Warehouse browser (schema → table, with a manual fallback) ----

/**
 * Browse a registered warehouse: list schemas, then tables for a chosen schema, and
 * report the chosen `{schema, table}` up via `onSelect`. If discovery is not possible
 * (Fabric/OneLake, or the catalog is not registered yet) it shows the honest note and
 * a manual schema/table input so the user can still proceed.
 */
export function WarehouseBrowser({
  connId,
  onSelect,
}: {
  connId: string;
  onSelect: (sel: BrowseSelection | null) => void;
}) {
  const [loading, setLoading] = useState(false);
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [tables, setTables] = useState<string[]>([]);
  const [schema, setSchema] = useState('');
  const [table, setTable] = useState('');
  const [note, setNote] = useState('');
  // When discovery is unavailable we fall back to manual entry (Fabric / unregistered).
  const [manual, setManual] = useState(false);
  // Hold onSelect in a ref so the load effect depends ONLY on connId — an inline
  // parent callback (e.g. the browse-only card) never re-triggers discovery.
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const emit = useCallback((sel: BrowseSelection | null) => onSelectRef.current(sel), []);

  // Load schemas once per connection. A fresh connection resets everything.
  const loadSchemas = useCallback(async () => {
    setLoading(true);
    setNote('');
    setSchemas(null);
    setTables([]);
    setSchema('');
    setTable('');
    emit(null);
    try {
      const { data } = await postJSON(`/api/connections/${connId}/discover`);
      const r = data as unknown as DiscoverResult & { notDiscoverable?: boolean };
      if (r.ok && Array.isArray(r.schemas)) {
        setSchemas(r.schemas);
        setManual(false);
        if (r.schemas.length === 0) setNote(r.detail ?? 'No schemas visible in this catalog yet.');
      } else {
        // Honest: not discoverable (Fabric/OneLake) or not registered/queryable yet.
        setManual(true);
        setNote(r.detail ?? 'This catalog can’t be browsed — enter the schema and table to import.');
      }
    } catch (e) {
      setManual(true);
      setNote(`Couldn’t reach discovery (${(e as Error).message}) — enter the schema and table manually.`);
    } finally {
      setLoading(false);
    }
  }, [connId, emit]);

  useEffect(() => { loadSchemas(); }, [loadSchemas]);

  async function pickSchema(s: string) {
    setSchema(s);
    setTable('');
    setTables([]);
    emit(null);
    if (!s) return;
    setLoading(true);
    try {
      const { data } = await postJSON(`/api/connections/${connId}/discover`, { schema: s });
      const r = data as unknown as DiscoverResult;
      setTables(Array.isArray(r.tables) ? r.tables : []);
      if (r.ok && (!r.tables || r.tables.length === 0)) setNote(r.detail ?? `No tables in '${s}'.`);
      else setNote('');
    } catch (e) {
      setNote(`Couldn’t list tables (${(e as Error).message}).`);
    } finally {
      setLoading(false);
    }
  }

  function pickTable(t: string) {
    setTable(t);
    emit(schema && t ? { schema, table: t } : null);
  }

  // Manual mode: two free-text inputs (honest for Fabric / unregistered catalogs).
  if (manual) {
    return (
      <div style={{ marginTop: 10 }}>
        {note ? <p className="hint" style={{ marginTop: 0, marginBottom: 8 }}>{note}</p> : null}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={schema}
            onChange={(e) => { setSchema(e.target.value); emit(e.target.value.trim() && table.trim() ? { schema: e.target.value.trim(), table: table.trim() } : null); }}
            placeholder="Schema (e.g. sales)"
            style={{ flex: '1 1 140px' }}
            autoComplete="off"
          />
          <input
            type="text"
            value={table}
            onChange={(e) => { setTable(e.target.value); emit(schema.trim() && e.target.value.trim() ? { schema: schema.trim(), table: e.target.value.trim() } : null); }}
            placeholder="Table (e.g. orders)"
            style={{ flex: '1 1 140px' }}
            autoComplete="off"
          />
          <button className="btn ghost" onClick={loadSchemas} disabled={loading} title="Retry auto-discovery">
            {loading ? <span className="spin" /> : 'Retry browse'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          value={schema}
          onChange={(e) => pickSchema(e.target.value)}
          disabled={loading || !schemas}
          style={{ flex: '1 1 160px' }}
        >
          <option value="">{loading && !schemas ? 'Loading schemas…' : 'Choose a schema…'}</option>
          {(schemas ?? []).map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <select
          value={table}
          onChange={(e) => pickTable(e.target.value)}
          disabled={loading || !schema || tables.length === 0}
          style={{ flex: '1 1 160px' }}
        >
          <option value="">{schema ? (tables.length ? 'Choose a table…' : 'No tables') : 'Pick a schema first'}</option>
          {tables.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        {loading ? <span className="spin" /> : null}
      </div>
      {note ? <p className="hint" style={{ marginTop: 8, marginBottom: 0 }}>{note}</p> : null}
    </div>
  );
}

// ---- Data-tab import panel --------------------------------------------------

/**
 * "Import from warehouse" — the Data-tab affordance. Pick a registered warehouse
 * connection, browse it, name the target dataset + choose a domain, and Import. On
 * success it calls `onImported(datasetId?)` so the host can refresh the tiles and
 * (when the route returns a dataset id) jump to it.
 */
export default function WarehouseImportPanel({
  connections,
  domains,
  onClose,
  onImported,
}: {
  connections: WarehouseConn[];
  domains: string[];
  onClose: () => void;
  onImported: (datasetId?: string) => void;
}) {
  const [connId, setConnId] = useState(connections[0]?.id ?? '');
  const [sel, setSel] = useState<BrowseSelection | null>(null);
  const [targetName, setTargetName] = useState('');
  const conn = connections.find((c) => c.id === connId);
  const [domain, setDomain] = useState(conn?.domain ?? domains[0] ?? '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [done, setDone] = useState<{ target: string; rows: number | null } | null>(null);

  // Default the target name to the source table (a user can override it).
  useEffect(() => { if (sel?.table && !targetName) setTargetName(sel.table); }, [sel, targetName]);
  // Keep the domain sensible when the connection changes.
  useEffect(() => { setDomain(conn?.domain ?? domains[0] ?? ''); }, [conn, domains]);

  async function runImport() {
    if (!conn || !sel || !targetName.trim() || !domain || busy) return;
    setBusy(true);
    setMsg('');
    try {
      const { ok, data } = await postJSON(`/api/connections/${conn.id}/import`, {
        schema: sel.schema,
        table: sel.table,
        name: targetName.trim(),
        targetDomain: domain,
      });
      const r = data as unknown as ImportResult & { datasetId?: string };
      if (ok && r.ok !== false) {
        const rows = typeof r.rowsAffected === 'number' ? r.rowsAffected : (typeof (data as { rowCount?: number }).rowCount === 'number' ? (data as { rowCount?: number }).rowCount! : null);
        setDone({ target: r.target ?? `iceberg.${domain}.${targetName.trim()}`, rows });
        onImported(r.datasetId ?? (data as { datasetId?: string }).datasetId);
      } else {
        setMsg(`✗ ${r.error ?? 'Import failed'}`);
      }
    } catch (e) {
      setMsg(`✗ ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginTop: 16, borderColor: 'var(--gold-line)' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <h3 style={{ margin: 0 }}>Import from warehouse</h3>
          <p className="hint" style={{ marginTop: 6, marginBottom: 0, maxWidth: 520 }}>
            Materialize a table from a registered warehouse into your lakehouse — it becomes a
            normal governed dataset you can refine <strong>Bronze → Silver → Gold</strong>. The
            catalog wiring stays in the engine room.
          </p>
        </div>
        <button className="btn ghost" onClick={onClose}>Close</button>
      </div>

      {connections.length === 0 ? (
        <div className="stub-page" style={{ marginTop: 14 }}>
          No registered warehouse connections yet. Create one in the Connections tab, Register its
          catalog, then Test — it appears here.
        </div>
      ) : done ? (
        <div className="answer" style={{ marginTop: 14 }}>
          ✓ Imported <span className="mono">{done.target}</span>
          {done.rows !== null ? <> — {done.rows} row(s)</> : null}. It’s now a governed dataset.
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <button className="btn" onClick={onClose}>See it in Data</button>
            <button className="btn ghost" onClick={() => { setDone(null); setSel(null); setTargetName(''); }}>
              Import another
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="row" style={{ gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
            <select
              value={connId}
              onChange={(e) => { setConnId(e.target.value); setSel(null); setTargetName(''); }}
              style={{ flex: '2 1 200px' }}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>{c.name} · {c.platform}</option>
              ))}
            </select>
          </div>

          {conn ? <WarehouseBrowser connId={conn.id} onSelect={setSel} /> : null}

          <div className="row" style={{ gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={targetName}
              onChange={(e) => setTargetName(e.target.value)}
              placeholder="Target dataset name (e.g. orders) — [a-z_][a-z0-9_]*"
              style={{ flex: '2 1 200px' }}
              autoComplete="off"
            />
            {domains.length > 1 ? (
              <select value={domain} onChange={(e) => setDomain(e.target.value)} style={{ flex: '1 1 140px' }} title="Domain to land it in">
                {domains.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            ) : null}
          </div>

          <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
            <button className="btn" onClick={runImport} disabled={busy || !sel || !targetName.trim() || !domain}>
              {busy ? <span className="spin" /> : `Import → iceberg.${domain || 'domain'}.${targetName.trim() || 'name'}`}
            </button>
          </div>
          {msg ? <div className="error" style={{ marginTop: 10 }}>{msg}</div> : null}
        </>
      )}
    </div>
  );
}
