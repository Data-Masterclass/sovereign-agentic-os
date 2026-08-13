/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useMemo, useState } from 'react';
import { Alert, Badge, Input, Select, Spinner, Table } from '@/lib/app-ui/index.ts';
import type { OsClient, QueryResult } from '@/lib/app-sdk/index.ts';
import {
  applyView,
  formatCell,
  resolveColumns,
  type FilterValue,
  type ResolvedColumn,
} from '@/lib/software/appspec/render-logic.ts';
import type { RecordsTableConfig } from '@/lib/software/appspec/patterns.ts';

/**
 * Render the `records-table` pattern against the governed `os.datasets.query`. Fetching,
 * column-mapping (BY NAME, robust to schema drift), formatting, search/filter/sort/pagination
 * all flow through the pure render-logic helpers — this component owns only the fetch lifecycle
 * and the chrome. Loading → Spinner, error → Alert(error), empty → Alert(info); success is
 * HONEST (never a fabricated row). `view` is the pattern's `RecordsTableConfig`.
 */
export function TableViewRenderer({ view, os }: { view: RecordsTableConfig; os: OsClient }) {
  const [state, setState] = useState<{ status: 'loading' | 'ready' | 'error'; result?: QueryResult; error?: string }>({
    status: 'loading',
  });

  // View-state controls (all client-side over the fetched grid — the Phase-1 pipeline).
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [sort, setSort] = useState<{ field: string; dir: 'asc' | 'desc' } | undefined>(
    view.sort ? { field: view.sort, dir: 'asc' } : undefined,
  );
  const [page, setPage] = useState(0);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    os.datasets
      .query(view.source.datasetId, { limit: 1000 })
      .then((result) => {
        if (alive) setState({ status: 'ready', result });
      })
      .catch((e: unknown) => {
        if (alive) setState({ status: 'error', error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      alive = false;
    };
  }, [os, view.source.datasetId]);

  const resolved: ResolvedColumn[] = useMemo(
    () => (state.result ? resolveColumns(state.result.columns, view.columns) : []),
    [state.result, view.columns],
  );

  // Distinct values per `select` filter field, from the live grid (honest options).
  const selectOptions = useMemo(() => {
    const out: Record<string, string[]> = {};
    if (!state.result) return out;
    for (const f of view.filters ?? []) {
      if (f.control !== 'select') continue;
      const col = resolved.find((c) => c.field === f.field);
      if (!col || col.index < 0) continue;
      const seen = new Set<string>();
      for (const row of state.result.rows) {
        const v = row[col.index] ?? '';
        if (v !== '') seen.add(v);
      }
      out[f.field] = Array.from(seen).sort();
    }
    return out;
  }, [state.result, resolved, view.filters]);

  const pageSize = view.pageSize && view.pageSize > 0 ? view.pageSize : 25;

  const view$ = useMemo(() => {
    if (!state.result) return { rows: [] as string[][], total: 0 };
    const fv: Record<string, FilterValue> = {};
    for (const f of view.filters ?? []) {
      const raw = filters[f.field];
      if (raw === undefined || raw === '') continue;
      if (f.control === 'range') {
        // "min-max", "min-", "-max" — either bound optional.
        const [minS, maxS] = raw.split('-', 2);
        const min = minS?.trim() ? Number(minS) : undefined;
        const max = maxS?.trim() ? Number(maxS) : undefined;
        fv[f.field] = { control: 'range', ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) };
      } else {
        fv[f.field] = { control: f.control, value: raw };
      }
    }
    return applyView(state.result.rows, resolved, {
      search: view.search ? search : undefined,
      filters: fv,
      sort,
      page,
      pageSize,
    });
  }, [state.result, resolved, view.filters, view.search, filters, search, sort, page, pageSize]);

  if (state.status === 'loading') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: 12 }}>
        <Spinner /> <span>Loading…</span>
      </div>
    );
  }
  if (state.status === 'error') {
    return <Alert variant="error">Could not load this table: {state.error}</Alert>;
  }

  const totalPages = Math.max(1, Math.ceil(view$.total / pageSize));

  function toggleSort(field: string) {
    setPage(0);
    setSort((prev) =>
      prev && prev.field === field ? { field, dir: prev.dir === 'asc' ? 'desc' : 'asc' } : { field, dir: 'asc' },
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {(view.search || (view.filters && view.filters.length > 0)) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {view.search && (
            <Input
              placeholder="Search…"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              style={{ maxWidth: 220 }}
            />
          )}
          {(view.filters ?? []).map((f) => {
            const label = resolved.find((c) => c.field === f.field)?.label ?? f.field;
            if (f.control === 'select') {
              return (
                <Select
                  key={f.field}
                  value={filters[f.field] ?? ''}
                  onChange={(e) => {
                    setFilters((p) => ({ ...p, [f.field]: e.target.value }));
                    setPage(0);
                  }}
                  aria-label={`Filter ${label}`}
                >
                  <option value="">{label}: all</option>
                  {(selectOptions[f.field] ?? []).map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </Select>
              );
            }
            return (
              <Input
                key={f.field}
                placeholder={f.control === 'range' ? `${label} (min-max)` : `Filter ${label}`}
                value={filters[f.field] ?? ''}
                onChange={(e) => {
                  setFilters((p) => ({ ...p, [f.field]: e.target.value }));
                  setPage(0);
                }}
                style={{ maxWidth: 180 }}
              />
            );
          })}
        </div>
      )}

      <Table>
        <thead>
          <tr>
            {resolved.map((c) => {
              const active = sort?.field === c.field;
              return (
                <th
                  key={c.field}
                  onClick={() => toggleSort(c.field)}
                  style={{ cursor: 'pointer', userSelect: 'none' }}
                  title="Sort by this column"
                >
                  {c.label}
                  {active ? (sort?.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {view$.rows.map((row, i) => (
            <tr key={i}>
              {resolved.map((c) => {
                const raw = c.index >= 0 ? row[c.index] ?? '' : '';
                if (c.index < 0) return <td key={c.field}>—</td>;
                const text = formatCell(raw, c.format);
                return (
                  <td key={c.field}>{c.format === 'badge' ? <Badge>{text}</Badge> : text}</td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Table>

      {view$.total === 0 ? (
        <Alert variant="info">No rows match.</Alert>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13 }}>
          <span>
            {view$.total} row{view$.total === 1 ? '' : 's'}
          </span>
          {totalPages > 1 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button type="button" className="sb-btn sb-ghost sb-sm" disabled={page <= 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
                ‹ Prev
              </button>
              <span>
                Page {page + 1} of {totalPages}
              </span>
              <button type="button" className="sb-btn sb-ghost sb-sm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}>
                Next ›
              </button>
            </span>
          )}
        </div>
      )}
    </div>
  );
}
