/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import Link from 'next/link';
import PageHeader from '@/components/PageHeader';
import StackStatus from '@/components/StackStatus';
import ThemeToggle from '@/components/ThemeToggle';
import { config } from '@/lib/core/config';

// Server component: a read-only view of this deployment's configuration. Only
// non-secret values are read from config (no keys/passwords); live enabled
// components come from /api/status via the StackStatus client component.

export const dynamic = 'force-dynamic';

const DEPLOYMENT = [
  { k: 'Tenant', v: config.deploymentTenant },
  { k: 'Domain', v: config.deploymentDomain },
  { k: 'Namespace', v: config.deploymentNamespace },
  { k: 'Profile', v: config.deploymentProfile },
];

const VERSIONS = [
  { k: 'OS UI', v: config.osVersion },
  { k: 'Next.js', v: '15.5.19' },
  { k: 'React', v: '19.0.0' },
  { k: 'Node', v: '22.x' },
];

export default function SettingsPage() {
  return (
    <>
      <PageHeader title="Settings" crumb="deployment configuration — read-only" />
      <div className="content">
        <p className="lead">
          Read-only configuration for this deployment: tenant and domain identity, the
          enabled components, and versions. Member/role management and quotas are governed in
          the <Link href="/governance">Governance</Link> tab; secrets never surface here.
        </p>

        <div className="section-title">Deployment</div>
        <div className="grid">
          {DEPLOYMENT.map((d) => (
            <div className="card" key={d.k}>
              <h3>{d.k}</h3>
              <div className="big" style={{ fontSize: 20 }}>{d.v}</div>
            </div>
          ))}
        </div>

        <StackStatus />

        <div className="section-title">Versions</div>
        <div className="grid">
          {VERSIONS.map((v) => (
            <div className="card" key={v.k}>
              <h3>{v.k}</h3>
              <div className="big" style={{ fontSize: 20 }} >{v.v}</div>
            </div>
          ))}
        </div>

        <div className="section-title">Appearance</div>
        <div className="card">
          <div className="row" style={{ alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 240 }}>
              <div style={{ fontWeight: 600 }}>Theme</div>
              <div className="muted">
                <strong>Light</strong> is the default — a white content area with black and
                gold text. <strong>Dark</strong> restores the Sovereign Agentic brand palette
                (gold <code>#c8a24a</code> on <code>#0c0b0d</code>). The navigation stays dark
                in both modes. Your choice is saved on this device.
              </div>
            </div>
            <ThemeToggle />
          </div>
        </div>

        <div className="hint">
          See <Link href="/about">About / Licenses</Link> for the full component + license
          list. Deployment identity is set via <code>OS_TENANT</code>, <code>OS_DOMAIN</code>,{' '}
          <code>OS_NAMESPACE</code>, <code>OS_PROFILE</code>, and <code>OS_VERSION</code>.
        </div>
      </div>
    </>
  );
}
