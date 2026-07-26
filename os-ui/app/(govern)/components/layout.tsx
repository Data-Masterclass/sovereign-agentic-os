/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { currentUser } from '@/lib/core/auth';

/**
 * Server guard for the Components console. Admin-only: exposes cluster workload
 * toggles and internal service addresses, so only admins may enter.
 * The /api/platform/* routes enforce the same via requireAdmin() — defence in depth.
 */
export default async function ComponentsLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user || user.role !== 'admin') {
    return (
      <div className="content">
        <div className="stub-page" style={{ marginTop: 20 }}>
          This area is for platform administrators. You are signed in as a{' '}
          <strong>{user?.role ?? 'guest'}</strong>.
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
