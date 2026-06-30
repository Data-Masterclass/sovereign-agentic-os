/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useState } from 'react';
import { useUser } from '@/lib/useUser';
import { postJson, TIER_LABEL } from './shared';
import type { DashboardSummary, DashTier, GovernResponse } from './shared';

/**
 * Govern — promote (Builder → Domain) / certify (Admin → Marketplace) the selected
 * dashboard, gated by role. Broadening the tier never broadens the rows: a shared or
 * certified dashboard stays per-viewer RLS-scoped via the guest token.
 */
export default function Govern({
  selected,
  onGoverned,
}: {
  selected: DashboardSummary | null;
  onGoverned: (tier: DashTier) => void;
}) {
  const { user } = useUser();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'promote' | 'certify' | null>(null);
  const [ok, setOk] = useState('');

  if (!selected) {
    return (
      <div className="stub-page" style={{ marginTop: 18 }}>
        Select or open a dashboard in the Tiles tab to govern it.
      </div>
    );
  }

  const role = user?.role;
  const canPromote = role === 'builder' || role === 'admin';
  const canCertify = role === 'admin';

  const govern = async (transition: 'promote' | 'certify') => {
    setError('');
    setOk('');
    setBusy(transition);
    try {
      const res = await postJson<GovernResponse>('/api/dashboards/govern', {
        dashboardId: selected.id,
        transition,
      });
      onGoverned(res.tier);
      setOk(`Dashboard is now ${TIER_LABEL[res.tier]} (${res.tier}).`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="agent-editor" style={{ marginTop: 18 }}>
      <div className="agent-editor-head">
        <div>
          <div className="agent-editor-title">Govern — {selected.name}</div>
          <div className="hint" style={{ marginTop: 2 }}>
            Current tier: <span className={`badge vis-${selected.tier === 'personal' ? 'personal' : selected.tier === 'domain' ? 'shared' : 'certified'}`}>{TIER_LABEL[selected.tier]}</span>
            {role ? <> · signed in as <strong>{role}</strong></> : null}
          </div>
        </div>
      </div>

      <div className="row" style={{ marginTop: 14, gap: 10 }}>
        <button className="btn" onClick={() => govern('promote')} disabled={!canPromote || busy !== null}>
          {busy === 'promote' ? <span className="spin" /> : 'Promote → Domain'}
        </button>
        <button className="btn ghost" onClick={() => govern('certify')} disabled={!canCertify || busy !== null}>
          {busy === 'certify' ? <span className="spin" /> : 'Certify → Marketplace'}
        </button>
      </div>
      {!canPromote ? (
        <div className="hint" style={{ marginTop: 8 }}>Promotion needs the Builder role; certification needs Admin.</div>
      ) : !canCertify ? (
        <div className="hint" style={{ marginTop: 8 }}>Certification needs the Admin role.</div>
      ) : null}

      {error ? <div className="error" style={{ marginTop: 12 }}>{error}</div> : null}
      {ok ? <div className="passthrough-note" style={{ marginTop: 12 }}>✓ {ok}</div> : null}
    </div>
  );
}
