/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <ConnectorGallery /> — the "Bring a connector" door: the connector-TYPE gallery, the
 * crown-jewel showcase. Grouped by vendor stack with a polished search, rendered straight
 * from the connection-template registry the API returns (`data.templates` +
 * `data.warehouse.providers`) so new templates appear on their own. Each tile leads with a
 * refined MONOGRAM mark (per-service accent, no trademarked logos) and the connector's
 * business value; protocol/auth detail is demoted to a quiet meta line. <strong>Connect →</strong>
 * opens the shared ConnectorWizard (Edit surface) pre-set to that type; <strong>Setup guide</strong>
 * opens the side panel.
 *
 * Presentation-only reshape: the SAME cards, filtering, grouping and handlers as before —
 * every `onConnect(start)` and guide payload is byte-identical; only the visual identity changed.
 */

import { useState } from 'react';
import { STACKS, vendorStack, warehousePlatformStack, type StackId } from '@/lib/connections/connector-stacks';
import { installGuideFor, type InstallGuide } from '@/lib/connections/install-guides';
import { connectorIdentity, markStyle } from '@/lib/connections/connector-identity';
import InstallationGuide from '@/components/connections/InstallationGuide';
import type { WizardStart } from '@/components/connections/ConnectorWizard';
import type { Template, WarehouseMeta } from './shared';
import type { CSSProperties } from 'react';

export default function ConnectorGallery({
  templates,
  warehouse,
  canOpen,
  onConnect,
}: {
  templates: Template[];
  warehouse?: WarehouseMeta;
  /** Whether the viewer may open the wizard (canCreate || canCreatePersonal). */
  canOpen: boolean;
  /** Open the shared wizard pre-set to the chosen type (lands in Edit). */
  onConnect: (start: WizardStart) => void;
}) {
  const [connSearch, setConnSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [guide, setGuide] = useState<InstallGuide | null>(null);

  const warehouseMeta = warehouse?.enabled ? warehouse : null;

  // A gallery card. `guideKey` resolves its Setup guide (a warehouse card uses its
  // provider platform; a template card uses its template key). `start` is how Connect opens
  // the shared wizard (a warehouse card pins the platform). `identityKey`/`platform` resolve
  // the monogram + per-service accent; `meta` is the demoted protocol/auth line.
  type Card = { key: string; guideKey: string; identityKey: string; platform?: string; label: string; meta: string; blurb?: string; stackId: StackId; start: WizardStart };

  // Dynamic: one card per user-facing template the API returned…
  const cards: Card[] = templates.map((t) => ({
    key: t.key,
    guideKey: t.key,
    identityKey: t.key,
    label: t.label,
    meta: `${t.type} · ${t.auth === 'oauth' ? 'sign in with your account' : 'service credentials'}`,
    stackId: vendorStack(t.key),
    start: { mode: 'type', template: t.key },
  }));

  // …plus ONE card PER warehouse provider (not a single generic warehouse card) when the
  // operator enabled external connectors. Each Connect opens the wizard pre-set to that
  // platform so it skips the generic platform-choice step.
  if (warehouseMeta) {
    for (const p of warehouseMeta.providers) {
      const caps = [
        p.capabilities.federate ? 'federate' : null,
        p.capabilities.import ? 'import' : null,
        p.capabilities.sync ? 'scheduled sync' : null,
      ].filter(Boolean).join(' · ');
      const kind = p.category === 'operational'
        ? 'Operational database'
        : p.category === 'streaming'
          ? 'Streaming'
          : 'Warehouse';
      cards.push({
        key: `warehouse:${p.platform}`,
        guideKey: p.platform,
        identityKey: 'warehouse',
        platform: p.platform,
        label: p.label,
        meta: `${kind}${caps ? ` · ${caps}` : ''}`,
        blurb: p.category === 'operational'
          ? 'Federate this database as a governed catalog — query live, import tables, keep copies fresh with scheduled sync.'
          : p.category === 'streaming'
            ? 'Federate topics as governed tables and land them in the lakehouse with scheduled sync.'
            : 'Federate this lakehouse as a governed catalog — query live, then import tables.',
        stackId: warehousePlatformStack(p.platform),
        start: { mode: 'type', template: 'warehouse', presetPlatform: p.platform },
      });
    }
  }

  if (cards.length === 0) return <div className="stub-page">No connectors are available on this deployment yet.</div>;

  // Filter by search query (name or stack label, case-insensitive).
  const q = connSearch.trim().toLowerCase();
  const filtered = q
    ? cards.filter((c) => {
        const stackLabel = STACKS.find((s) => s.id === c.stackId)?.label ?? '';
        return c.label.toLowerCase().includes(q) || stackLabel.toLowerCase().includes(q);
      })
    : cards;

  // Group filtered cards by vendor stack, preserving STACKS order. Empty stacks omitted.
  const grouped = new Map<StackId, Card[]>();
  for (const c of filtered) {
    const list = grouped.get(c.stackId) ?? [];
    list.push(c);
    grouped.set(c.stackId, list);
  }
  const visibleStacks = STACKS.filter((s) => (grouped.get(s.id)?.length ?? 0) > 0);

  return (
    <>
      {/* Search bar + stack jump-links */}
      <div style={{ marginBottom: 22 }}>
        <div className="conn-search">
          <span className="conn-search-ico" aria-hidden="true">⌕</span>
          <input
            type="search"
            value={connSearch}
            onChange={(e) => setConnSearch(e.target.value)}
            placeholder="Search connectors by name or vendor…"
            aria-label="Search connectors"
          />
        </div>
        {visibleStacks.length > 0 && (
          <div className="conn-jump" role="navigation" aria-label="Jump to connector stack">
            {visibleStacks.map((stack) => (
              <button
                key={stack.id}
                type="button"
                className="conn-jump-chip"
                aria-label={`Jump to ${stack.label} connectors`}
                onClick={() => {
                  const el = document.getElementById(`stack-${stack.id}`);
                  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                <span className="conn-jump-dot" aria-hidden="true" style={{ background: stack.accent }} />
                {stack.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="stub-page">No connectors match &ldquo;{connSearch}&rdquo;.</div>
      ) : (
        visibleStacks.map((stack) => {
          const group = grouped.get(stack.id)!;
          const isOpen = !collapsedCategories.has(stack.id);
          return (
            <section key={stack.id} id={`stack-${stack.id}`} className="conn-stack">
              {/* Stack header — accent bar + label + count, collapsible */}
              <button
                type="button"
                className="conn-stack-head"
                aria-expanded={isOpen}
                onClick={() => setCollapsedCategories((prev) => {
                  const next = new Set(prev);
                  if (next.has(stack.id)) next.delete(stack.id); else next.add(stack.id);
                  return next;
                })}
              >
                <span className="conn-stack-bar" aria-hidden="true" style={{ background: stack.accent }} />
                <span className="conn-stack-caret" aria-hidden="true" style={{ transform: isOpen ? 'rotate(90deg)' : 'none' }}>▸</span>
                <span className="conn-stack-label">{stack.label}</span>
                <span className="conn-stack-count">{group.length}</span>
                <span className="conn-stack-rule" aria-hidden="true" />
              </button>

              {isOpen ? (
                <div className="conn-tiles">
                  {group.map((c) => {
                    const g = installGuideFor(c.guideKey);
                    const id = connectorIdentity(c.identityKey, { platform: c.platform, label: c.label, fallbackValue: c.blurb });
                    return (
                      <div className="conn-tile" key={c.key} style={markStyle(id.accent) as CSSProperties}>
                        <span className="conn-tile-ready" aria-hidden="true"><span className="dot" />ready</span>
                        <div className="conn-tile-top">
                          <span className="conn-mono" aria-hidden="true">{id.monogram}</span>
                          <div className="conn-tile-heading">
                            <h3 className="conn-tile-name" title={c.label}>{c.label}</h3>
                          </div>
                        </div>
                        <p className="conn-tile-value">{id.value}</p>
                        <div className="conn-tile-meta">{c.meta}</div>
                        <div className="conn-tile-actions">
                          {g ? <button className="btn ghost sm" onClick={() => setGuide(g)}>Setup guide</button> : null}
                          {canOpen ? <button className="btn sm" onClick={() => onConnect(c.start)}>Connect →</button> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </section>
          );
        })
      )}

      {/* Setup guide side panel — opened from any tile. */}
      {guide ? <InstallationGuide guide={guide} onClose={() => setGuide(null)} /> : null}
    </>
  );
}
