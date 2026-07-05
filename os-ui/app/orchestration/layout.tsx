/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { currentUser } from '@/lib/auth';

/**
 * Server guard for the Orchestration (Dagster) console. Admin-only: shows
 * pipeline runs and dbt assets across all domains.
 * The /api/orchestration route enforces requireUser(); this layout tightens to admin.
 */
export default async function OrchestrationLayout({ children }: { children: React.ReactNode }) {
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
