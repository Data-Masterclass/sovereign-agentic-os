/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import PageHeader from '@/components/PageHeader';
import Terminal from '@/components/Terminal';
import { config } from '@/lib/config';
import { currentUser } from '@/lib/auth';

// Server component: gates the Terminal tab on the OS role (admin-only) + the
// feature flag BEFORE shipping any client code, then hands off to the xterm.js
// client. The token route (/api/terminal/token) re-checks both — defence in depth.
export const dynamic = 'force-dynamic';

export default async function TerminalPage() {
  const user = await currentUser();

  // Platform-group admin gate: non-admins get a calm boundary, not a broken render.
  if (!user || user.role !== 'admin') {
    return (
      <>
        <PageHeader title="Terminal" crumb="sandboxed teaching shell — ephemeral, network-restricted" />
        <div className="content">
          <div className="stub-page" style={{ marginTop: 20 }}>
            This area is for platform administrators. You are signed in as a{' '}
            <strong>{user?.role ?? 'guest'}</strong>.
          </div>
        </div>
      </>
    );
  }

  const enabled = config.terminalEnabled;
  const authorised = config.terminalAllowedRoles.includes(user.role);

  return (
    <>
      <PageHeader title="Terminal" crumb="sandboxed teaching shell — ephemeral, network-restricted" />
      <div className="content">
        {!enabled ? (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Terminal is disabled</h3>
            <p className="muted">
              The sandboxed terminal is off in this environment. An administrator enables it via
              <code> terminal.enabled=true</code> in the chart (it is the highest-risk surface, so it
              ships opt-in, pending sign-off).
            </p>
          </div>
        ) : !authorised ? (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>Not authorised</h3>
            <p className="muted">
              Your role ({user?.role ?? 'guest'}) cannot open a terminal. Allowed roles:{' '}
              <strong>{config.terminalAllowedRoles.join(', ')}</strong>.
            </p>
          </div>
        ) : (
          <>
            <p className="lead">
              An ephemeral, locked-down shell (python3) scoped to your domain&apos;s governed
              data. It starts when you open this tab, stays connected while you move around the OS,
              and is destroyed when you sign out (or after a generous idle window). It cannot reach
              the cluster API, read secrets, or the public internet.
            </p>
            <Terminal />
          </>
        )}
      </div>
    </>
  );
}
