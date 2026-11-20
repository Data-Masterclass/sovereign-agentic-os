/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        admin
 * FEATURE:    Backups & Restore — the live state of every backup and restore drill, as a Platform tab
 * USER STORY: As a platform admin I want to see, per backup, what the tool itself reports — last
 *             run, result, age, location — red when it failed and amber when it is missing or
 *             stale, and no Restore button that restores nothing.
 * ARCHITECTURE:
 *   - GET /api/platform-admin/backups → `listBackups()` (lib/backups.ts), the same live read as
 *     the Monitoring backup alerts. The page renders the rows as returned; it adds no status.
 *   - Restore stays a runbook procedure (docs/backups.md); the API refuses one with 501.
 *   - The page's `.content` wrapper moved up to platform/page.tsx; the leftover plain <div> is it.
 *   - FAIL-CLOSED gate: Platform is minRole 'builder' (only Overview & Health is builder-readable),
 *     and every section now lives at /platform, so the old pathname gate in platform/layout.tsx no
 *     longer protects this surface. The gate is therefore HERE as well as in the strip: the inner
 *     component — which holds every hook and every fetch — is not mounted until useUser() resolves a
 *     role that clears sectionMinRole('backups'). A builder who hand-crafts ?section=backups gets nothing,
 *     and nothing is requested on their behalf. Hiding is not the boundary: /api/platform-admin/* is
 *     adminCtx()-gated server-side, which is the real enforcement.
 */
'use client';

import { useEffect, useState } from 'react';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { sectionMinRole } from '@tabs/admin/lib/sections';
import type { BackupRow } from '@tabs/admin/lib/backup-status-core';

const BADGE: Record<BackupRow['health'], string> = { green: 'ok', amber: 'warn', red: 'err' };

export default function BackupsRestore() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  // Fail closed: BackupsRestoreInner holds every hook and every fetch, so until the role
  // resolves AND clears the floor nothing renders and nothing is requested.
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('backups'))) return null;
  return <BackupsRestoreInner />;
}

function BackupsRestoreInner() {
  const [rows, setRows] = useState<BackupRow[] | null>(null);
  const [checkedAt, setCheckedAt] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/platform-admin/backups', { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok) setError(body.error ?? 'Failed to load');
        else { setRows(body.backups ?? []); setCheckedAt(body.checkedAt ?? ''); }
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);

  return (
    <div>
      {error ? <div className="error" role="alert">Backup status could not be read: {error}</div> : null}
      <div className="section-title">Backups</div>
      <p className="hint">Read live from each tool: Kubernetes (pg-dump, snapshot jobs), Velero, OpenSearch and the restore drills.{checkedAt ? ` Checked ${new Date(checkedAt).toLocaleString()}.` : ''} Restores follow the runbook, docs/backups.md.</p>
      {rows === null && !error ? <p className="muted">Reading backup status…</p> : null}
      {rows && rows.length === 0 ? <p className="error" role="status" data-testid="backup-none">This release runs no backup at all.</p> : null}
      {rows && rows.length > 0 ? (
        <div className="table-wrap">
          <table data-testid="backup-rows">
            <thead><tr><th>Backup</th><th>Status</th><th>Last</th><th>Details</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-health={r.health}>
                  <td><strong>{r.name}</strong><div className="muted" style={{ fontSize: 11 }}>{r.source}</div></td>
                  <td><span className={`badge ${BADGE[r.health]}`}>{r.status}</span></td>
                  <td>{r.lastAt ? new Date(r.lastAt).toLocaleString() : '—'}{r.ageHours !== null ? <div className="muted" style={{ fontSize: 11 }}>{r.ageHours} h ago</div> : null}</td>
                  <td className="muted" style={{ fontSize: 12 }}>{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
