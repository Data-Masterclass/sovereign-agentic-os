/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import PageHeader from '@/components/PageHeader';
import Workbench from '@/components/Workbench';
import { config } from '@/lib/config';
import { currentUser } from '@/lib/auth';

// Server component: gates the Workbench tab on the OS role (admin-only) + the
// feature flag BEFORE shipping any client code, then hands off to the client
// launcher. The session route (/api/workbench/session) re-checks role AND
// domain membership — defence in depth.
export const dynamic = 'force-dynamic';

export default async function WorkbenchPage() {
  const user = await currentUser();

  // Platform-group admin gate: non-admins get a calm boundary, not a broken render.
  if (!user || user.role !== 'admin') {
    return (
      <>
        <PageHeader
          title="Workbench"
          crumb="persistent, domain-scoped code-server — build software, agents, data & knowledge"
        />
        <div className="content">
          <div className="stub-page" style={{ marginTop: 20 }}>
            This area is for platform administrators. You are signed in as a{' '}
            <strong>{user?.role ?? 'guest'}</strong>.
          </div>
        </div>
      </>
    );
  }

  const enabled = config.workbenchEnabled;
  const authorised = config.workbenchAllowedRoles.includes(user.role);

  return (
    <>
      <PageHeader
        title="Workbench"
        crumb="persistent, domain-scoped code-server — build software, agents, data & knowledge"
      />
      <div className="content">
        {!enabled ? (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Workbench is disabled</h3>
            <p className="muted">
              The domain-builder workbench is off in this environment. An administrator enables it via
              <code> workbench.enabled=true</code> in the chart (it carries more access than the
              terminal — persistence + domain credentials + git — so it ships opt-in, pending sign-off).
            </p>
          </div>
        ) : !authorised ? (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Not authorised</h3>
            <p className="muted">
              Your role ({user?.role ?? 'guest'}) cannot open a workbench. Allowed roles:{' '}
              <strong>{config.workbenchAllowedRoles.join(', ')}</strong>. The workbench is for the{' '}
              <code>builder</code> role, scoped to your domain.
            </p>
          </div>
        ) : (
          <>
            <p className="lead">
              A persistent, domain-scoped VS Code editor (git + python + duckdb + the governed{' '}
              <code>dq</code> data CLI) where you build, edit, and administer ALL of your domain&apos;s
              artifacts — software repos, agent definitions, governed data, and knowledge — in one place.
              Your work persists on a per-builder volume across sessions. It cannot reach another
              domain&apos;s artifacts, the cluster API, secrets, or the public internet.
            </p>
            <Workbench domains={user!.domains} />
          </>
        )}
      </div>
    </>
  );
}
