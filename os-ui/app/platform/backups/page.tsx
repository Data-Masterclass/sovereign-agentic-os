/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import GuardedConfirm from '@/components/GuardedConfirm';

type Target = {
  id: string; name: string; method: string; frequency: string; retention: string;
  lastRun: string; lastStatus: 'success' | 'failed'; restorePhrase: string;
};
type Restore = { id: string; target: string; startedBy: string; startedAt: string; status: string; auditId: string };

export default function BackupsPage() {
  const [targets, setTargets] = useState<Target[]>([]);
  const [restores, setRestores] = useState<Restore[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<Target | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const res = await fetch('/api/platform-admin/backups', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else { setTargets(body.targets ?? []); setRestores(body.restores ?? []); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const doRestore = useCallback(async () => {
    if (!pending) return;
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/platform-admin/backups', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ targetId: pending.id, confirm: pending.restorePhrase }),
      });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Restore failed');
      else { setToast(`Restore of ${pending.name} started — audited (${body.auditId}).`); setPending(null); await load(); }
    } finally { setBusy(false); }
  }, [pending, load]);

  return (
    <>
      <PageHeader title="Backups & Restore" crumb="platform · protect & recover (backup-strategy.md)" />
      <div className="content">
        <p className="lead">
          Each protected store backs up to sovereign object storage. Restore is the canonical destructive
          action: it is <strong>guarded</strong> (type the phrase), <strong>confirmed</strong>, and
          <strong> audited</strong> — and only acts on already-provisioned backups, never provisions
          infrastructure. Backup-failure alerts also surface in <Link href="/monitoring">Monitoring</Link>.
        </p>

        {toast ? <div className="hint" style={{ color: 'var(--teal)' }}>{toast}</div> : null}
        {error ? <div className="error">{error}</div> : null}

        <div className="section-title">Protected stores<span className="count-pill">{targets.length}</span></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Store</th><th>Method</th><th>Frequency</th><th>Retention</th><th>Last run</th><th></th></tr></thead>
            <tbody>
              {targets.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.name}</strong></td>
                  <td className="muted" style={{ fontSize: 12 }}>{t.method}</td>
                  <td>{t.frequency}</td>
                  <td>{t.retention}</td>
                  <td>
                    <span className={`badge ${t.lastStatus === 'success' ? 'ok' : 'err'}`}>{t.lastStatus}</span>
                    <div className="muted" style={{ fontSize: 11 }}>{new Date(t.lastRun).toLocaleString()}</div>
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn ghost" style={{ padding: '4px 10px' }} onClick={() => setPending(t)}>Restore…</button>
                  </td>
                </tr>
              ))}
              {!loading && targets.length === 0 ? <tr><td colSpan={6} className="muted">No backup targets.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="section-title" style={{ marginTop: 22 }}>
          Recent restores
          <Link href="/governance" className="hint" style={{ marginLeft: 10, textTransform: 'none', letterSpacing: 0 }}>audit in Governance →</Link>
        </div>
        {restores.length === 0 ? (
          <div className="hint">No restores triggered this session.</div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Target</th><th>By</th><th>Started</th><th>Status</th><th>Audit</th></tr></thead>
              <tbody>
                {restores.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.target}</strong></td>
                    <td>{r.startedBy}</td>
                    <td className="muted" style={{ fontSize: 11.5 }}>{new Date(r.startedAt).toLocaleString()}</td>
                    <td><span className="badge ok">{r.status}</span></td>
                    <td className="mono" style={{ fontSize: 11.5 }}>{r.auditId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <GuardedConfirm
        open={!!pending}
        title={pending ? `Restore ${pending.name}?` : ''}
        phrase={pending?.restorePhrase ?? ''}
        detail={pending ? `Restores "${pending.name}" from the last ${pending.lastStatus} backup (${pending.method}). This overwrites current state and cannot be undone.` : ''}
        confirmLabel="Restore now"
        busy={busy}
        onConfirm={doRestore}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
