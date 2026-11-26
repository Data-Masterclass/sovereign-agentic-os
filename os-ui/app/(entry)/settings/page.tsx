/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import Link from 'next/link';
import PageHeader from '@core/ui/PageHeader';
import StackStatus from '@core/ui/StackStatus';
import ThemeToggle from '@core/ui/ThemeToggle';
import LanguagePicker from '@core/ui/LanguagePicker';
import { TechnicalDetailsToggle } from '@core/ui/TechnicalDetails';
import { version as reactVersion } from 'react';
import nextPackage from 'next/package.json';
import { config } from '@core/kernel/config';
import { currentUser } from '@core/kernel/auth';
import { roleAtLeast } from '@core/kernel/session';
import { getTranslations } from '@core/i18n/server';

// Server component: My Settings. Every signed-in user sets their language and appearance here; the read-only view
// of this deployment's configuration (non-secret values only — no keys/passwords) is for builder+ only, re-checked
// here because the account menu's minRole is advisory. Live enabled components come from /api/status via the
// StackStatus client component. I18N: converted (wave 1) — the `settings` namespace.

export const dynamic = 'force-dynamic';

export default async function SettingsPage() {
  const t = await getTranslations('settings');
  const user = await currentUser();
  const showDeployment = !!user && roleAtLeast(user.role, 'builder');

  const DEPLOYMENT = [
    { k: t('deployment.tenant'), v: config.deploymentTenant },
    { k: t('deployment.domain'), v: config.deploymentDomain },
    { k: t('deployment.namespace'), v: config.deploymentNamespace },
    { k: t('deployment.profile'), v: config.deploymentProfile },
  ];

  // Read from the running process and its installed packages, never typed in (WP-05, GLUE-4).
  const VERSIONS = [
    { k: 'OS UI', v: config.osVersion || t('versions.unknown') },
    { k: 'Next.js', v: nextPackage.version },
    { k: 'React', v: reactVersion },
    { k: 'Node', v: process.versions.node },
  ];

  const strong = (chunks: React.ReactNode) => <strong>{chunks}</strong>;
  const code = (chunks: React.ReactNode) => <code>{chunks}</code>;

  return (
    <>
      <PageHeader title={t('title')} />
      <div className="content">
        {showDeployment ? (
          <>
            <div className="section-title" style={{ marginTop: 0 }}>{t('sections.deployment')}</div>
            <div className="grid">
              {DEPLOYMENT.map((d) => (
                <div className="card" key={d.k}>
                  <h3>{d.k}</h3>
                  <div className="big" style={{ fontSize: 20 }}>{d.v}</div>
                </div>
              ))}
            </div>

            <StackStatus />

            <div className="section-title">{t('sections.versions')}</div>
            <div className="grid">
              {VERSIONS.map((v) => (
                <div className="card" key={v.k}>
                  <h3>{v.k}</h3>
                  <div className="big" style={{ fontSize: 20 }} >{v.v}</div>
                </div>
              ))}
            </div>
          </>
        ) : null}

        <div className="section-title" style={showDeployment ? undefined : { marginTop: 0 }}>{t('sections.language')}</div>
        <div className="card">
          <div className="row" style={{ alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontWeight: 600 }}>{t('language.title')}</div>
              <div className="muted">{t('language.body')}</div>
            </div>
            <LanguagePicker />
          </div>
        </div>

        <div className="section-title">{t('sections.appearance')}</div>
        <div className="card">
          <div className="row" style={{ alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontWeight: 600 }}>{t('theme.title')}</div>
              <div className="muted">{t.rich('theme.body', { strong, code })}</div>
            </div>
            <ThemeToggle />
          </div>
        </div>
        <div className="card" style={{ marginTop: 14 }}>
          <div className="row" style={{ alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontWeight: 600 }}>{t('technical.title')}</div>
              <div className="muted">{t.rich('technical.body', { strong })}</div>
            </div>
            <TechnicalDetailsToggle />
          </div>
        </div>

        <div className="hint">
          {t.rich(showDeployment ? 'hintAdmin' : 'hint', { link: (chunks) => <Link href="/about">{chunks}</Link>, code })}
        </div>
      </div>
    </>
  );
}
