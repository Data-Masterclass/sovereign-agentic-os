/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import PageHeader from '@core/ui/PageHeader';
import { useUser } from '@core/ui/useUser';
import { useTranslations } from '@core/i18n/client';
import { DEFAULT_SECTION, GROUP_I18N_KEY, SECTION_I18N_KEY, resolveSection, visibleSections, type AdminSection } from '@tabs/admin/lib/sections';
import OverviewHealth from '@tabs/admin/ui/OverviewHealth';
import DomainsAdmin from '@tabs/admin/ui/DomainsAdmin';
import TenantSettings from '@tabs/admin/ui/TenantSettings';
import UsersAccess from '@tabs/admin/ui/UsersAccess';
import ModelsProviders from '@tabs/admin/ui/ModelsProviders';
import BackupsRestore from '@tabs/admin/ui/BackupsRestore';
import AccessTokens from '@tabs/admin/ui/AccessTokens';
import ReindexSection from '@tabs/admin/ui/ReindexSection';
import DescribeFilesSection from '@tabs/admin/ui/DescribeFilesSection';
import ToolConsoles from '@tabs/admin/ui/ToolConsoles';
import EncryptionKeys from '@tabs/admin/ui/EncryptionKeys';
import PolicyData from '@tabs/admin/ui/PolicyData';
import GoLiveRules from '@tabs/admin/ui/GoLiveRules';
import { useAppBuilderFlag } from '@core/ui/lifecycle/useAppBuilderFlag';

/**
 * Platform — ONE route, tabs on top, exactly like Governance.
 *
 * The tile grid is GONE (2026-10-30). This page used to be a grouped grid of
 * links into /platform/<id> sub-routes; before that it had a section strip AND
 * the grid, which is why the strip was deleted. The answer was never "which of
 * the two", it was "one": a `.tabstrip` that switches content in place, the
 * pattern app/(govern)/governance/page.tsx already uses. The old sub-routes
 * remain as redirects to ?section=<id>, so links and bookmarks still work.
 *
 * SECURITY — the gate moved from the route to the tab. The old layout allowed any
 * non-admin at exactly `/platform` and bounced them out of every deeper
 * `/platform/*` path; that worked only while each admin surface WAS a deeper
 * path. Now they all live here, so:
 *   - `visibleSections(role)` builds the strip FAIL-CLOSED — an unresolved role
 *     (still loading, or anonymous) gets no tabs at all, so an admin tab can
 *     never flash into a builder's strip;
 *   - `resolveSection(?section=, role)` refuses a deep link to a tab the role may
 *     not see, so `/platform?section=domains` typed by a builder renders NOTHING
 *     rather than falling back to something;
 *   - each section component checks `sectionMinRole(<id>)` again on its own and
 *     keeps its hooks (and therefore its fetches) behind that check;
 *   - and the real enforcement is unchanged: every /api/platform-admin/* route is
 *     adminCtx()-gated server-side. The UI gate is defence in depth.
 * The one builder-readable tab is Overview & Health, which is builder-readable
 * with admin-only actions (see tabs/admin/ui/OverviewHealth.tsx).
 *
 * I18N:       converted (wave 2) — texts from `admin.platform.*` and `admin.nav.*` (section labels by
 * `SECTION_I18N_KEY`, groups by `GROUP_I18N_KEY` in sections.ts; a section without a key shows its English label).
 */
export default function PlatformPage() {
  return (
    <Suspense fallback={null}>
      <PlatformPageInner />
    </Suspense>
  );
}

function PlatformPageInner() {
  const t = useTranslations('admin');
  const sectionText = (s: AdminSection, part: 'label' | 'sub'): string => {
    const k = SECTION_I18N_KEY[s.id as keyof typeof SECTION_I18N_KEY];
    return k ? t(`nav.sections.${k}.${part}`) : s[part];
  };
  const searchParams = useSearchParams();
  const { user, loading } = useUser();
  // Fail closed: treat "still loading" exactly like "no role" — null — so the
  // strip and the body are both empty until /api/auth/me answers.
  const role = loading ? null : user?.role ?? null;

  // ?section=<id> deep-links a tab (the sidebar entry, Governance's cross-link
  // back to Users & Access, an overview alert pointing at Backups). Applied in an
  // effect too, so an in-page <Link> to ?section=… switches without a remount.
  const sectionParam = searchParams?.get('section') ?? null;
  const [section, setSection] = useState<string | null>(sectionParam ?? DEFAULT_SECTION);
  useEffect(() => { if (sectionParam) setSection(sectionParam); }, [sectionParam]);

  // App Builder (F): Go-live rules is in the strip only while the switch is on (learned from the header's own
  // preference read, no extra request); with it off this strip is exactly as before.
  const appBuilder = useAppBuilderFlag();
  const visible = visibleSections(role, { appBuilder });
  const current = resolveSection(section, role, { appBuilder });

  return (
    <>
      <PageHeader
        title={t('platform.title')}
        crumb={t('platform.crumb')}
      />
      <div className="content">
        {/* Eleven tabs in one row ran far off the right edge, so most people never saw the
            last ones. Grouped rows (Tenant · Models · Infrastructure) that WRAP keep every
            tab visible at any width, with no sideways scrolling. */}
        <nav aria-label={t('platform.navAria')} style={{ display: 'grid', gap: 6, marginBottom: 24 }}>
          {Array.from(new Set(visible.map((s) => s.group))).map((group) => (
            <div key={group} style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span className="hint" style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.6, minWidth: 104 }}>{t(`nav.groups.${GROUP_I18N_KEY[group]}`)}</span>
              <div className="tabstrip" style={{ flexWrap: 'wrap', margin: 0, flex: 1 }}>
                {visible.filter((s) => s.group === group).map((s) => (
                  <button
                    key={s.id}
                    className={current === s.id ? 'active' : ''}
                    aria-current={current === s.id ? 'page' : undefined}
                    onClick={() => setSection(s.id)}
                    title={sectionText(s, 'sub')}
                    style={{ whiteSpace: 'nowrap' }}
                  >
                    {sectionText(s, 'label')}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>

        {current === 'overview' && <OverviewHealth />}
        {current === 'domains' && <DomainsAdmin />}
        {current === 'settings' && <TenantSettings />}
        {current === 'access' && <UsersAccess />}
        {current === 'models' && <ModelsProviders />}
        {current === 'backups' && <BackupsRestore />}
        {current === 'tokens' && <AccessTokens />}
        {current === 'encryption-keys' && <EncryptionKeys />}
        {current === 'policy-data' && <PolicyData />}
        {current === 'reindex' && <><ReindexSection /><DescribeFilesSection /></>}
        {current === 'tools' && <ToolConsoles />}
        {current === 'go-live-rules' && <GoLiveRules />}
      </div>
    </>
  );
}
