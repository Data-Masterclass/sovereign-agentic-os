/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import PageHeader from '@/components/PageHeader';
import ListingCard from '@/components/marketplace/ListingCard';
import type { Listing } from '@/components/marketplace/ListingCard';
import ListingDrawer from '@/components/marketplace/ListingDrawer';
import MyImports from '@/components/marketplace/MyImports';
import MarketplaceDataProducts from '@/components/data/MarketplaceDataProducts';

type User = { id: string; domains: string[]; role: 'creator' | 'builder' | 'domain_admin' | 'admin' };
type ApiData = { user: User; source: 'live' | 'offline-mock'; items: Listing[] };

const PRODUCT_TYPES: [string, string][] = [
  ['dataset', 'Data product'],
  ['transformation', 'Transformation'],
  ['metric', 'Metric'],
  ['dashboard', 'Dashboard'],
  ['agent', 'Agent'],
  ['knowledge', 'Knowledge'],
  ['connection', 'Connection'],
  ['file', 'Files'],
  ['app', 'App'],
];

export default function MarketplacePage() {
  const [data, setData] = useState<ApiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [q, setQ] = useState('');
  const [activeQ, setActiveQ] = useState('');
  const [type, setType] = useState('');
  const [domain, setDomain] = useState('');
  const [tag, setTag] = useState('');
  const [showImports, setShowImports] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  // Debounce search query by 320 ms
  useEffect(() => {
    const t = setTimeout(() => setActiveQ(q), 320);
    return () => clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const p = new URLSearchParams();
      if (activeQ) p.set('q', activeQ);
      if (type) p.set('type', type);
      if (domain) p.set('domain', domain);
      if (tag) p.set('tag', tag);
      const res = await fetch(`/api/marketplace?${p}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) setError(body.error ?? 'Failed to load');
      else setData(body as ApiData);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [activeQ, type, domain, tag]);

  useEffect(() => { load(); }, [load]);

  // Derive filter options from whatever the API returned
  const domains = useMemo(
    () => [...new Set((data?.items ?? []).map((i) => i.ownerDomain))].sort(),
    [data],
  );
  const tags = useMemo(
    () => [...new Set((data?.items ?? []).flatMap((i) => i.tags))].sort(),
    [data],
  );
  const userDomains = data?.user.domains ?? [];
  const items = data?.items ?? [];

  return (
    <>
      <PageHeader
        title="Marketplace"
        crumb="discover & import certified products across domains"
        tutorial="marketplace"
      />
      <div className="content">
        <p className="lead">
          Cross-domain catalog of Admin-<strong>certified</strong> products of every type.{' '}
          <strong>Import = a governed grant</strong>: the owner stays the source of truth;
          you consume it under your own identity with row-level security.
          Browsing is open; importing is governed.
        </p>

        {/* Controls row */}
        <div
          className="row"
          style={{ flexWrap: 'wrap', alignItems: 'center', gap: 10, margin: '18px 0 4px' }}
        >
          <input
            type="text"
            placeholder="Search products…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ width: 220, flex: 'none' }}
          />
          <select value={domain} onChange={(e) => setDomain(e.target.value)}>
            <option value="">All domains</option>
            {domains.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">All tags</option>
            {tags.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>

          {/* Right side: source pill + view toggle */}
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
            {data && (
              <span className="pill">
                {data.source === 'live' && <span className="live" />}
                {data.source}
              </span>
            )}
            <button
              className="btn ghost"
              onClick={() => setShowImports((v) => !v)}
            >
              {showImports ? 'Browse' : 'My imports'}
            </button>
          </div>
        </div>

        {/* Type tabstrip — hidden in My Imports view */}
        {!showImports && (
          <div className="tabstrip">
            <button className={!type ? 'active' : ''} onClick={() => setType('')}>
              All
            </button>
            {PRODUCT_TYPES.map(([k, label]) => (
              <button
                key={k}
                className={type === k ? 'active' : ''}
                onClick={() => setType(k)}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {/* Certified data products from the Data tab — only in Browse view. */}
        {!showImports && <MarketplaceDataProducts />}

        {error && (
          <div className="error" style={{ margin: '16px 0' }}>{error}</div>
        )}

        {/* Main content area */}
        {showImports ? (
          <MyImports />
        ) : loading ? (
          <div className="stub-page" style={{ marginTop: 20 }}>
            <span className="spin" style={{ marginRight: 10 }} />
            Loading catalog…
          </div>
        ) : items.length === 0 ? (
          <div className="stub-page" style={{ marginTop: 20 }}>
            No certified products found
            {type
              ? ` of type "${PRODUCT_TYPES.find(([k]) => k === type)?.[1] ?? type}"`
              : ''}
            .
          </div>
        ) : (
          <div className="grid" style={{ marginTop: 18 }}>
            {items.map((l) => (
              <ListingCard
                key={l.id}
                listing={l}
                onOpen={() => setOpenId(l.id)}
                ownDomain={userDomains.includes(l.ownerDomain)}
              />
            ))}
          </div>
        )}
      </div>

      {openId && (
        <ListingDrawer
          listingId={openId}
          viewerDomains={userDomains}
          isAdmin={data?.user.role === 'admin'}
          onClose={() => setOpenId(null)}
          onChanged={load}
        />
      )}
    </>
  );
}
