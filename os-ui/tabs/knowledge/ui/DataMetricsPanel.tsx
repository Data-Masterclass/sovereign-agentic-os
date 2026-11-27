/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useEffect, useState } from 'react';
import type { WorkflowLinks } from '@tabs/knowledge/lib/links';
import { useTranslations, useServerMessage } from '@core/i18n/client';

/**
 * Data & Metrics panel — link the governed datasets and KPIs this business process
 * runs on. Calm surface: linked items as chips (name + scope badge, deep-linking to
 * the artifact via the OS-wide `?focus=<id>` handler), plus one small picker per
 * kind. Options come from the SAME viewer-scoped list endpoints the Data / Metrics
 * tabs use, so a user can only ever link what they can see; the server re-checks.
 */

type Option = { id: string; name: string; scope: 'My' | 'Domain' | 'Company' };

type Groups<T> = { mine?: T[]; domain?: T[]; marketplace?: T[] };

function flatten<T extends { id: string; name: string }>(g: Groups<T>): Option[] {
  return [
    ...(g.mine ?? []).map((x) => ({ id: x.id, name: x.name, scope: 'My' as const })),
    ...(g.domain ?? []).map((x) => ({ id: x.id, name: x.name, scope: 'Domain' as const })),
    ...(g.marketplace ?? []).map((x) => ({ id: x.id, name: x.name, scope: 'Company' as const })),
  ];
}

const SCOPE_CLASS: Record<Option['scope'], string> = { My: 'vis-personal', Domain: 'vis-shared', Company: 'vis-certified' };
const SCOPE_KEY = { My: 'my', Domain: 'domain', Company: 'company' } as const;

export default function DataMetricsPanel({
  workflowId,
  links,
  canEdit,
  onChanged,
}: {
  workflowId: string;
  links: WorkflowLinks;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const t = useTranslations('knowledge');
  const msg = useServerMessage();
  const scopeLabel = (sc: Option['scope']) => t(`scope.${SCOPE_KEY[sc]}`);
  const [datasets, setDatasets] = useState<Option[] | null>(null);
  const [metrics, setMetrics] = useState<Option[] | null>(null);
  const [pickDataset, setPickDataset] = useState('');
  const [pickMetric, setPickMetric] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let live = true;
    fetch('/api/data/datasets', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setDatasets(d ? flatten(d) : []); })
      .catch(() => { if (live) setDatasets([]); });
    fetch('/api/metrics', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (live) setMetrics(d ? flatten(d) : []); })
      .catch(() => { if (live) setMetrics([]); });
    return () => { live = false; };
  }, []);

  async function save(next: WorkflowLinks) {
    if (saving) return;
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/knowledge/workflows/${workflowId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ links: next }),
      });
      const d = await res.json();
      if (!res.ok) { setError(msg(d, t('dm.saveFailed'))); return; }
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const section = (
    kind: 'datasets' | 'metrics',
    label: string,
    options: Option[] | null,
    href: (id: string) => string,
    pick: string,
    setPick: (v: string) => void,
    empty: string,
    addPrompt: string,
  ) => {
    const linked = links[kind];
    const available = (options ?? []).filter((o) => !linked.includes(o.id));
    const byId = new Map((options ?? []).map((o) => [o.id, o]));
    return (
      <>
        <div className="section-title" style={{ marginTop: kind === 'metrics' ? 24 : 0 }}>{label}</div>
        {linked.length === 0 ? (
          <div className="muted" style={{ fontSize: 13 }}>{empty}</div>
        ) : (
          <div className="dm-chips">
            {linked.map((id) => {
              const o = byId.get(id);
              return (
                <span key={id} className="dm-chip">
                  <a href={href(id)} title={o ? t('dm.openItem', { name: o.name }) : id}>{o?.name ?? id}</a>
                  <span className={`badge ${o ? SCOPE_CLASS[o.scope] : 'muted'}`} style={{ fontSize: 10 }}>
                    {o ? scopeLabel(o.scope) : t('dm.unavailable')}
                  </span>
                  {canEdit && (
                    <button
                      className="dm-x"
                      title={t('dm.unlink')}
                      aria-label={t('dm.unlinkItem', { name: o?.name ?? id })}
                      disabled={saving}
                      onClick={() => void save({ ...links, [kind]: linked.filter((x) => x !== id) })}
                    >✕</button>
                  )}
                </span>
              );
            })}
          </div>
        )}
        {canEdit && (
          <div className="dm-add">
            <select value={pick} onChange={(e) => setPick(e.target.value)} disabled={options === null || saving}>
              <option value="">{options === null ? t('dm.loading') : available.length === 0 ? t('dm.nothingLeft') : addPrompt}</option>
              {available.map((o) => (
                <option key={o.id} value={o.id}>{o.name} · {scopeLabel(o.scope)}</option>
              ))}
            </select>
            <button
              className="btn ghost sm"
              disabled={!pick || saving}
              onClick={() => { if (pick) { void save({ ...links, [kind]: [...linked, pick] }); setPick(''); } }}
            >
              {saving ? <span className="spin" /> : t('dm.link')}
            </button>
          </div>
        )}
      </>
    );
  };

  return (
    <div className="dm-panel">
      {section('datasets', t('dm.datasets'), datasets, (id) => `/data?focus=${encodeURIComponent(id)}`,
        pickDataset, setPickDataset, t('dm.emptyDatasets'), t('dm.addDataset'))}
      {section('metrics', t('dm.metrics'), metrics, (id) => `/metrics?focus=${encodeURIComponent(id)}`,
        pickMetric, setPickMetric, t('dm.emptyMetrics'), t('dm.addMetric'))}

      {error && <div className="error" style={{ marginTop: 12 }}>{error}</div>}

      <style>{DmStyles}</style>
    </div>
  );
}

const DmStyles = `
.dm-chips { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.dm-chip {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 6px 10px; border: 1px solid var(--border); border-radius: 999px;
  background: var(--bg); font-size: 13px;
}
.dm-chip a { color: var(--text); text-decoration: none; }
.dm-chip a:hover { text-decoration: underline; }
.dm-x { background: none; border: none; cursor: pointer; color: var(--text-faint); font-size: 12px; padding: 0 2px; }
.dm-x:hover { color: var(--danger); }
.dm-add { display: flex; gap: 8px; margin-top: 10px; align-items: center; }
.dm-add select {
  font-family: var(--font-body); font-size: 13px; padding: 7px 9px; max-width: 340px;
  background: var(--bg-input); color: var(--text);
  border: 1px solid var(--border-strong); border-radius: 8px;
}
`;
