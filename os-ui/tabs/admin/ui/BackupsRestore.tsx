/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
/**
 * TAB:        admin
 * FEATURE:    Backups & Restore — what this page can and cannot tell an admin, as a Platform tab
 * USER STORY: As a platform admin I want this page to say plainly that backup status is not
 *             connected to it yet and where the real state and the restore procedure are, instead
 *             of a table of invented "success" rows and a Restore button that restores nothing.
 * ARCHITECTURE:
 *   - No reader of the backup jobs exists (lib/backups.ts), so the page shows BACKUP_STATUS_NOTE
 *     and lists only targets the API really returns (none today). The Restore action is removed;
 *     the API refuses one with 501 and records nothing.
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
import { BACKUP_STATUS_NOTE, type BackupTarget } from '@tabs/admin/lib/backups';

export default function BackupsRestore() {
  const { user, loading } = useUser();
  const role = user?.role ?? null;
  // Fail closed: BackupsRestoreInner holds every hook and every fetch, so until the role
  // resolves AND clears the floor nothing renders and nothing is requested.
  if (loading || role === null || !roleAtLeast(role, sectionMinRole('backups'))) return null;
  return <BackupsRestoreInner />;
}

function BackupsRestoreInner() {
  const [targets, setTargets] = useState<BackupTarget[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/platform-admin/backups', { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok) setError(body.error ?? 'Failed to load');
        else setTargets(body.targets ?? []);
      } catch (e) { setError((e as Error).message); }
    })();
  }, []);

  return (
    <div>
      {error ? <div className="error">{error}</div> : null}
      <div className="section-title">Backups</div>
      <p className="hint" role="status" data-testid="backup-status-note">{BACKUP_STATUS_NOTE}</p>
      {targets.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Store</th><th>Method</th><th>Frequency</th><th>Retention</th><th>Last run</th></tr></thead>
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
