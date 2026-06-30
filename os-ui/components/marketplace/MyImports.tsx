/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * "My imports" — self-fetching list of the grants this viewer holds across
 * Marketplace listings, grouped by status (active / pending / revoked). Each row
 * shows the product, type, import mode, target domain, enforcement, and scope.
 */

type ProductType =
  | 'dataset' | 'transformation' | 'metric' | 'dashboard' | 'agent'
  | 'knowledge' | 'connection' | 'file' | 'app';
type ImportMode = 'read-grant' | 'fork' | 'deploy-instance' | 'template';
type EnforcementTarget = 'opa-trino' | 'cube-rls' | 'opensearch-dls' | 'instance' | 'template' | 'copy';

type Grant = {
  id: string;
  listingId: string;
  type: ProductType;
  productName: string;
  mode: ImportMode;
  granteeDomain: string;
  ownerDomain: string;
  scope: { rows: string; columns?: string[] };
  enforcedBy: EnforcementTarget;
  status: 'active' | 'pending' | 'revoked';
  approvalId?: string;
  derivedId?: string;
};

const TYPE_LABEL: Record<ProductType, string> = {
  dataset: 'Data product',
  transformation: 'Transformation',
  metric: 'Metric',
  dashboard: 'Dashboard',
  agent: 'Agent',
  knowledge: 'Knowledge',
  connection: 'Connection',
  file: 'Files',
  app: 'App',
};

const MODE_LABEL: Record<ImportMode, string> = {
  'read-grant': 'Read in place (governed grant)',
  fork: 'Fork to own (editable copy)',
  'deploy-instance': 'Deploy your own instance',
  template: 'Use as template (your own creds)',
};

const ENFORCEMENT_LABEL: Record<EnforcementTarget, string> = {
  'cube-rls': 'Cube row-level security',
  'opensearch-dls': 'OpenSearch Document-Level Security',
  'opa-trino': 'Trino + OPA row filter',
  copy: 'Forked copy',
  template: 'Connection template',
  instance: 'Own instance',
};

const GROUPS: { status: Grant['status']; label: string }[] = [
  { status: 'active', label: 'Active' },
  { status: 'pending', label: 'Pending approval' },
  { status: 'revoked', label: 'Revoked' },
];

function statusBadge(s: Grant['status']) {
  if (s === 'active') return 'badge ok';
  if (s === 'pending') return 'badge warn';
  return 'badge muted';
}

export default function MyImports() {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const res = await fetch('/api/marketplace/imports', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? `Request failed (${res.status})`);
      else setGrants((body.grants ?? []) as Grant[]);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="error">{error}</div>;
  if (!grants) return <div className="hint"><span className="spin" /> Loading your imports…</div>;
  if (grants.length === 0) {
    return <div className="stub-page">You haven&apos;t imported anything yet.</div>;
  }

  return (
    <>
      {GROUPS.map(({ status, label }) => {
        const rows = grants.filter((g) => g.status === status);
        if (rows.length === 0) return null;
        return (
          <div key={status}>
            <div className="section-title">{label} <span className="muted" style={{ fontSize: 12 }}>({rows.length})</span></div>
            <div style={{ display: 'grid', gap: 10 }}>
              {rows.map((g) => (
                <ImportRow key={g.id} g={g} />
              ))}
            </div>
          </div>
        );
      })}
    </>
  );
}

function ImportRow({ g }: { g: Grant }) {
  return (
    <div className="card" style={{ padding: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{g.productName}</span>
          <span className="badge">{TYPE_LABEL[g.type] ?? g.type}</span>
        </div>
        <span className={statusBadge(g.status)}>{g.status}</span>
      </div>
      <div className="muted" style={{ marginTop: 8, fontSize: 12.5, lineHeight: 1.7 }}>
        <div>{MODE_LABEL[g.mode] ?? g.mode} · → {g.granteeDomain}</div>
        <div>Enforced by {ENFORCEMENT_LABEL[g.enforcedBy] ?? g.enforcedBy}</div>
        {g.scope?.rows ? (
          <div>Scope: <span className="mono" style={{ fontSize: 12 }}>{g.scope.rows}</span></div>
        ) : null}
      </div>
    </div>
  );
}
