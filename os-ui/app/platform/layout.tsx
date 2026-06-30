/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { currentUser } from '@/lib/auth';
import PlatformNav from '@/components/PlatformNav';

/**
 * Platform Admin shell — tenant-scoped, ABOVE the per-domain workspace. The
 * server guard makes the whole area Admin-only: a Builder/User who reaches the
 * route sees the boundary, never the controls (the API routes enforce the same
 * via `adminCtx()` + OPA). Renders the section sub-nav around each page.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user || user.role !== 'admin') {
    return (
      <div className="content">
        <div className="topbar">
          <div>
            <h1>Platform Admin</h1>
            <div className="crumb">tenant control room — Admin / owner only</div>
          </div>
        </div>
        <div className="stub-page" style={{ marginTop: 20 }}>
          Platform Admin is the tenant-level control room, visible to a <strong>tenant Admin / owner</strong> only.
          You are signed in as a <strong>{user?.role ?? 'guest'}</strong>. Manage your domain’s roles and
          memberships in <a href="/governance">Governance</a> instead.
        </div>
      </div>
    );
  }
  return (
    <>
      <PlatformNav />
      {children}
    </>
  );
}
