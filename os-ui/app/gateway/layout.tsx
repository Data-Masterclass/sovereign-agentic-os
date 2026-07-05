/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import { currentUser } from '@/lib/auth';

/**
 * Server guard for the Gateway (LiteLLM / MCP) console. Admin-only: exposes
 * model registry, MCP server wiring and master-key scoped operations.
 * The /api/gateway route enforces requireUser(); this layout tightens to admin.
 */
export default async function GatewayLayout({ children }: { children: React.ReactNode }) {
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
