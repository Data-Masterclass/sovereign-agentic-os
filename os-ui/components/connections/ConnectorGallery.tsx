/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * <ConnectorGallery /> — the "Use a connector" door: the connector-TYPE gallery,
 * grouped by vendor stack with a search bar, rendered straight from the connection-template
 * registry the API returns (`data.templates` + `data.warehouse.providers`) so new templates
 * appear on their own. Each card's <strong>Connect →</strong> opens the shared ConnectorWizard
 * (Edit surface) pre-set to that type; <strong>Installation Guide</strong> opens the side panel.
 *
 * This is the SAME gallery the connections page always showed — extracted verbatim from
 * GovernedConnections so the type-chooser can host it behind door A without a rewrite.
 */

import { useState } from 'react';
import { STACKS, vendorStack, warehousePlatformStack, type StackId } from '@/lib/connections/connector-stacks';
import { installGuideFor, type InstallGuide } from '@/lib/connections/install-guides';
import InstallationGuide from '@/components/connections/InstallationGuide';
import type { WizardStart } from '@/components/connections/ConnectorWizard';
import type { Template, WarehouseMeta } from './shared';

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

  // A gallery card. `guideKey` resolves its Installation Guide (a warehouse card uses its
  // provider platform; a template card uses its template key). `start` is how Connect opens
  // the shared wizard (a warehouse card pins the platform).
  type Card = { key: string; guideKey: string; label: string; meta: string; blurb?: string; stackId: StackId; start: WizardStart };

  // Dynamic: one card per user-facing template the API returned…
  const cards: Card[] = templates.map((t) => ({
    key: t.key,
    guideKey: t.key,
    label: t.label,
    meta: `${t.type} · ${t.auth === 'oauth' ? 'personal OAuth' : 'service credentials'}`,
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
        label: p.label,
        meta: `${kind} · federated Trino catalog${caps ? ` · ${caps}` : ''}`,
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

  if (cards.length === 0) return <div className="stub-page">No connector types available on this deployment.</div>;

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
      <div style={{ marginBottom: 18 }}>
        <input
          type="search"
          value={connSearch}
          onChange={(e) => setConnSearch(e.target.value)}
          placeholder="Search connectors by name or vendor…"
          style={{ width: '100%', maxWidth: 400 }}
        />
        {visibleStacks.length > 0 && (
          <div
            role="navigation"
            aria-label="Jump to connector stack"
            style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 8px', marginTop: 10 }}
          >
            {visibleStacks.map((stack) => (
              <button
                key={stack.id}
                type="button"
                aria-label={`Jump to ${stack.label} connectors`}
                onClick={() => {
                  const el = document.getElementById(`stack-${stack.id}`);
                  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                style={{
                  all: 'unset',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '3px 9px 3px 7px',
                  borderRadius: 20,
                  border: '1px solid var(--border)',
                  fontSize: 11,
                  fontFamily: 'var(--font-mono, monospace)',
                  color: 'var(--text-faint)',
                  background: 'var(--surface)',
                  letterSpacing: '0.04em',
                  transition: 'border-color 0.15s, color 0.15s',
                  lineHeight: 1.4,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = stack.accent;
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--text)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.borderColor = 'var(--border)';
                  (e.currentTarget as HTMLButtonElement).style.color = 'var(--text-faint)';
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: 6, height: 6, borderRadius: '50%', background: stack.accent, flexShrink: 0, opacity: 0.85 }}
                />
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
            <div key={stack.id} id={`stack-${stack.id}`} style={{ marginBottom: 24 }}>
              {/* Stack header — accent dot + label + count + rule */}
              <button
                type="button"
                onClick={() => setCollapsedCategories((prev) => {
                  const next = new Set(prev);
                  if (next.has(stack.id)) next.delete(stack.id); else next.add(stack.id);
                  return next;
                })}
                style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, marginBottom: isOpen ? 12 : 0, width: '100%' }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: 8, height: 8, borderRadius: '50%', background: stack.accent, flexShrink: 0, opacity: 0.85 }}
                />
                <span style={{
                  fontFamily: 'var(--font-mono, monospace)',
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  color: 'var(--text-faint)',
                  userSelect: 'none',
                }}>
                  {isOpen ? '▾' : '▸'} {stack.label}
                </span>
                <span className="badge muted" style={{ fontSize: 10 }}>{group.length}</span>
                <span style={{ flex: 1, height: 1, background: 'var(--border)', marginLeft: 4 }} />
              </button>

              {isOpen ? (
                <div className="grid">
                  {group.map((c) => {
                    const g = installGuideFor(c.guideKey);
                    return (
                      <div className="card" key={c.key} style={{ borderLeft: `3px solid ${stack.accent}`, paddingLeft: 14 }}>
                        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                          <h3 style={{ margin: 0 }}>{c.label}</h3>
                          <span className="badge ok">available</span>
                        </div>
                        <div className="muted" style={{ marginTop: 8 }}>{c.meta}</div>
                        {c.blurb ? <p className="hint" style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}>{c.blurb}</p> : null}
                        <div className="row" style={{ marginTop: 12, gap: 8, justifyContent: 'flex-end' }}>
                          {g ? <button className="btn ghost" onClick={() => setGuide(g)}>Installation Guide</button> : null}
                          {canOpen ? <button className="btn ghost" onClick={() => onConnect(c.start)}>Connect →</button> : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          );
        })
      )}

      {/* Installation Guide side panel — opened from any card. */}
      {guide ? <InstallationGuide guide={guide} onClose={() => setGuide(null)} /> : null}
    </>
  );
}
