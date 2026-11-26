/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 * I18N:       converted (wave 2) — texts from `connections.gallery.*`. Vendor-stack names are brands and stay as
 *             they are, except the two generic stacks ("Open source", "Other").
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
import { useTranslations } from '@core/i18n/client';
import { STACKS, vendorStack, warehousePlatformStack, type StackId } from '@tabs/connections/lib/connector-stacks';
import { installGuideFor, type InstallGuide } from '@tabs/connections/lib/install-guides';
import { connectorIdentity, markStyle } from '@tabs/connections/lib/connector-identity';
import InstallationGuide from '@tabs/connections/ui/InstallationGuide';
import type { WizardStart } from '@tabs/connections/ui/ConnectorWizard';
import type { Template, WarehouseMeta } from '@tabs/connections/ui/shared';
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
  const t = useTranslations('connections');
  const [connSearch, setConnSearch] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [guide, setGuide] = useState<InstallGuide | null>(null);

  const warehouseMeta = warehouse?.enabled ? warehouse : null;

  // A gallery card. `guideKey` resolves its Setup guide (a warehouse card uses its
  // provider platform; a template card uses its template key). `start` is how Connect opens
  // the shared wizard (a warehouse card pins the platform). `identityKey`/`platform` resolve
  // the monogram + per-service accent; `meta` is the demoted protocol/auth line.
  // The two generic stacks get a translated name; every other stack is a vendor brand.
  const stackName = (s: { id: StackId; label: string }): string =>
    s.id === 'opensource' ? t('gallery.stack.opensource') : s.id === 'other' ? t('gallery.stack.other') : s.label;

  type Card = { key: string; guideKey: string; identityKey: string; platform?: string; label: string; meta: string; blurb?: string; stackId: StackId; start: WizardStart };

  // Dynamic: one card per user-facing template the API returned…
  const cards: Card[] = templates.map((tp) => ({
    key: tp.key,
    guideKey: tp.key,
    identityKey: tp.key,
    label: tp.label,
    meta: tp.auth === 'oauth' ? t('gallery.metaOauth', { type: tp.type }) : t('gallery.metaService', { type: tp.type }),
    stackId: vendorStack(tp.key),
    start: { mode: 'type', template: tp.key },
  }));

  // …plus ONE card PER warehouse provider (not a single generic warehouse card) when the
  // operator enabled external connectors. Each Connect opens the wizard pre-set to that
  // platform so it skips the generic platform-choice step.
  if (warehouseMeta) {
    for (const p of warehouseMeta.providers) {
      const caps = [
        p.capabilities.federate ? t('gallery.capFederate') : null,
        p.capabilities.import ? t('gallery.capImport') : null,
        p.capabilities.sync ? t('gallery.capSync') : null,
      ].filter(Boolean).join(' · ');
      const kind = p.category === 'operational'
        ? t('gallery.kindOperational')
        : p.category === 'streaming'
          ? t('gallery.kindStreaming')
          : t('gallery.kindWarehouse');
      cards.push({
        key: `warehouse:${p.platform}`,
        guideKey: p.platform,
        identityKey: 'warehouse',
        platform: p.platform,
        label: p.label,
        meta: `${kind}${caps ? ` · ${caps}` : ''}`,
        blurb: p.category === 'operational'
          ? t('gallery.blurbOperational')
          : p.category === 'streaming'
            ? t('gallery.blurbStreaming')
            : t('gallery.blurbWarehouse'),
        stackId: warehousePlatformStack(p.platform),
        start: { mode: 'type', template: 'warehouse', presetPlatform: p.platform },
      });
    }
  }

  if (cards.length === 0) return <div className="stub-page">{t('gallery.empty')}</div>;

  // Filter by search query (name or stack label, case-insensitive).
  const q = connSearch.trim().toLowerCase();
  const filtered = q
    ? cards.filter((c) => {
        const stack = STACKS.find((s) => s.id === c.stackId);
        const stackLabel = stack?.label ?? '';
        const stackShown = stack ? stackName(stack) : '';
        return c.label.toLowerCase().includes(q) || stackLabel.toLowerCase().includes(q) || stackShown.toLowerCase().includes(q);
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
      {/* Under-construction notice — every connector is a PREVIEW that has not been end-to-end
          tested yet, so the tiles carry a "under construction" badge and this banner sets the
          expectation up front. Configure and explore, but do not rely on them in production. */}
      <div className="conn-wip-banner" role="note">
        <span className="conn-wip-banner-ico" aria-hidden="true">🚧</span>
        <span className="conn-wip-banner-text">
          {t.rich('gallery.wipBanner', { strong: (c) => <strong>{c}</strong> })}
        </span>
      </div>

      {/* Search bar + stack jump-links */}
      <div style={{ marginBottom: 22 }}>
        <div className="conn-search">
          <span className="conn-search-ico" aria-hidden="true">⌕</span>
          <input
            type="search"
            value={connSearch}
            onChange={(e) => setConnSearch(e.target.value)}
            placeholder={t('gallery.searchPlaceholder')}
            aria-label={t('gallery.searchAria')}
          />
        </div>
        {visibleStacks.length > 0 && (
          <div className="conn-jump" role="navigation" aria-label={t('gallery.jumpNav')}>
            {visibleStacks.map((stack) => (
              <button
                key={stack.id}
                type="button"
                className="conn-jump-chip"
                aria-label={t('gallery.jumpTo', { stack: stackName(stack) })}
                onClick={() => {
                  const el = document.getElementById(`stack-${stack.id}`);
                  el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                <span className="conn-jump-dot" aria-hidden="true" style={{ background: stack.accent }} />
                {stackName(stack)}
              </button>
            ))}
          </div>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="stub-page">{t('gallery.noMatch', { query: connSearch })}</div>
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
                <span className="conn-stack-label">{stackName(stack)}</span>
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
                        <span className="conn-tile-wip" title={t('gallery.wipTitle')}><span className="dot" />{t('gallery.wipBadge')}</span>
                        <div className="conn-tile-top">
                          <span className="conn-mono" aria-hidden="true">{id.monogram}</span>
                          <div className="conn-tile-heading">
                            <h3 className="conn-tile-name" title={c.label}>{c.label}</h3>
                          </div>
                        </div>
                        <p className="conn-tile-value">{id.value}</p>
                        <div className="conn-tile-meta">{c.meta}</div>
                        <div className="conn-tile-actions">
                          {g ? <button className="btn ghost sm" onClick={() => setGuide(g)}>{t('gallery.setupGuide')}</button> : null}
                          {canOpen ? <button className="btn sm" onClick={() => onConnect(c.start)}>{t('gallery.connect')}</button> : null}
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
