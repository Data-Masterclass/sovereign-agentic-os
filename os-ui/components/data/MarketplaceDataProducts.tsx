/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useUser } from '@/lib/useUser';
import { roleAtLeast } from '@/lib/session';

type Tile = { id: string; name: string; owner: string; domain: string; quality: string };

/**
 * Certified data products surfaced in /marketplace (locked decision: the marketplace
 * lives in the Data tab AND is surfaced here). Reuses the Data-tab list endpoint —
 * the same products, importable from here; "Open" jumps to the Data tab.
 */
export default function MarketplaceDataProducts() {
  const { user } = useUser();
  // Importing grants the whole domain read access → store gates to Builder/Admin.
  // Only surface Import to those roles so we never show a control the server 403s.
  const canImport = !!user && roleAtLeast(user.role, 'builder');
  const [items, setItems] = useState<Tile[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/data/datasets', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Failed to load'); return; }
      setItems(data.marketplace ?? []);
    } catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const importProduct = useCallback(async (id: string) => {
    setErr(''); setBusy(id);
    try {
      const res = await fetch(`/api/data/datasets/${id}/import`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) { setErr(data.error ?? 'Import failed'); return; }
      await load();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(''); }
  }, [load]);

  return (
    <>
      <div className="section-title" style={{ marginTop: 32 }}>
        Data products<span className="count-pill">{items?.length ?? 0}</span>
      </div>
      <p className="hint" style={{ marginTop: 0 }}>
        Certified, governed datasets published from any domain. Import one to query it (row/column-scoped to
        your entitlements), or <Link href="/data">open the Data tab</Link> to manage your own.
      </p>
      {err ? <div className="error">{err}</div> : null}
      {!items ? (
        <div className="stub-page">Loading data products…</div>
      ) : items.length === 0 ? (
        <div className="stub-page">No certified data products yet — an Admin certifies a data asset to publish it here.</div>
      ) : (
        <div className="grid">
          {items.map((p) => (
            <div className="card launch-card" key={p.id}>
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ margin: 0 }}>{p.name}</h3>
                <span className="badge vis-certified">Certified</span>
              </div>
              <div className="muted" style={{ marginTop: 6, fontSize: 11.5 }}>data product · from <strong>{p.domain}</strong> · {p.owner}</div>
              <div className="row" style={{ marginTop: 12, justifyContent: 'flex-end', gap: 8 }}>
                <Link className="btn ghost" href="/data">Open →</Link>
                {canImport ? (
                  <button className="btn" disabled={busy === p.id} onClick={() => importProduct(p.id)}>
                    {busy === p.id ? <span className="spin" /> : 'Import'}
                  </button>
                ) : (
                  <span className="hint" style={{ margin: 0 }} title="Importing shares the product with your whole domain">Ask a Builder to import</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
