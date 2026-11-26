/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        connections
 * FEATURE:    "Tenant connectors" — the admin-only block on Connections listing what this tenant admits
 * USER STORY: As a platform admin I want the tenant-wide connector registries where connections live,
 *             clearly separated from my own connections; as a creator I want to never see a tile I
 *             cannot open.
 * ARCHITECTURE:
 *   - Renders REGISTRIES (tabs/connections/lib/registries.ts) as its own titled block BELOW the
 *     user's own connection list, never mixed into it: the two answer different questions ("what am
 *     I connected to" vs "what may this tenant connect to"), and mixing them is what made these
 *     surfaces unfindable in the first place.
 *   - FAIL-CLOSED gate: nothing renders until useUser() resolves a role, so admin content can never
 *     flash to a creator mid-load, and a null/unknown role renders nothing at all. Hiding is not the
 *     security boundary — app/(govern)/platform/layout.tsx bounces non-admins off every one of these
 *     routes and each /api/platform-admin/* route re-checks via adminCtx().
 *   - Same tile markup and classes as the Platform menu (.section-title/.grid/.golden): no new
 *     design system, no new CSS.
 * I18N:       converted (wave 2) — texts from `connections.registries.*`; each tile's label and line are looked up
 *             by the registry's closed `id` (the English in registries.ts stays for its tests).
 */
'use client';

import Link from 'next/link';
import { useUser } from '@core/ui/useUser';
import { roleAtLeast } from '@core/kernel/session';
import { useTranslations } from '@core/i18n/client';
import { REGISTRIES, type Registry } from '@tabs/connections/lib/registries';

/** The catalog keys of each registry tile, by its stable id. */
const TILE_KEYS = {
  'mcp-apis': { label: 'registries.items.mcpApis.label', sub: 'registries.items.mcpApis.sub' },
  'oauth-apps': { label: 'registries.items.oauthApps.label', sub: 'registries.items.oauthApps.sub' },
  plugins: { label: 'registries.items.plugins.label', sub: 'registries.items.plugins.sub' },
} as const satisfies Record<Registry['id'], { label: string; sub: string }>;

export default function AdminRegistries() {
  const t = useTranslations('connections');
  const { user, loading } = useUser();
  const role = user?.role ?? null;

  // Fail closed while the role is unresolved: render nothing rather than flash.
  if (loading || role === null || !roleAtLeast(role, 'admin')) return null;

  const visible = REGISTRIES.filter((r) => roleAtLeast(role, r.minRole));
  if (visible.length === 0) return null;

  return (
    <div style={{ marginTop: 34, borderTop: '1px solid var(--border)', paddingTop: 22 }}>
      <div className="section-title" style={{ marginTop: 0 }}>{t('registries.title')}</div>
      <p className="muted" style={{ fontSize: 12.5, maxWidth: '68ch', marginTop: 0 }}>
        {t.rich('registries.intro', { strong: (c) => <strong>{c}</strong> })}
      </p>
      <div className="grid">
        {visible.map((r) => (
          <Link key={r.id} href={r.href} className="golden">
            <span className="ico">❖</span>
            <span><strong>{t(TILE_KEYS[r.id].label)}</strong><div className="muted" style={{ fontSize: 11.5 }}>{t(TILE_KEYS[r.id].sub)}</div></span>
            <span className="arr">→</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
