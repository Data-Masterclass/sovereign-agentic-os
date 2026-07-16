/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

/**
 * Console client — Shell | Query segmented control.
 *
 * Hosts the existing Terminal (xterm.js shell) and AdminQuery (Lakehouse SQL +
 * Cube semantic layer) surfaces under a single top-level Shell | Query switch.
 *
 * Reuses AdminQueryContent (components/AdminQueryContent.tsx — the inner query UI,
 * extracted from the former admin-query page) and Terminal (the xterm.js client
 * component) without touching their internals.
 *
 * The Terminal component is kept mounted in both states (via CSS display:none) so
 * the xterm.js session survives switching to Query and back with scrollback intact.
 *
 * Access split: the governed Query surface is builder+; the raw Shell (arbitrary
 * command execution in a sandbox) is an operator tool and is only rendered for
 * admins (`canShell`). A builder never sees the Shell switch or panel — and the
 * broker enforces the same bar independently, so hiding the UI is not the only
 * guard.
 */

import { useState } from 'react';
import PageHeader from '@/components/PageHeader';
import Terminal from '@/components/Terminal';
import AdminQueryContent from '@/components/AdminQueryContent';

type Panel = 'shell' | 'query';

export default function ConsoleClient({ canShell = false }: { canShell?: boolean }) {
  // Builders (no Shell) land straight on Query — the only surface they have.
  const [panel, setPanel] = useState<Panel>(canShell ? 'shell' : 'query');

  const switcher = canShell ? (
    <div className="row" style={{ gap: 8, marginBottom: 24 }}>
      <button
        type="button"
        className={panel === 'shell' ? 'btn' : 'btn btn-ghost'}
        onClick={() => setPanel('shell')}
      >
        Shell
      </button>
      <button
        type="button"
        className={panel === 'query' ? 'btn' : 'btn btn-ghost'}
        onClick={() => setPanel('query')}
      >
        Query
      </button>
    </div>
  ) : null;

  return (
    <>
      <PageHeader
        title="Console"
        crumb={canShell ? 'operator tools — shell · query' : 'governed query — SQL over the lakehouse & semantic layer'}
      />
      <div className="content">
        {switcher}

        {/* Shell panel — admin-only. Always mounted (when allowed); hidden while
            Query is active so the xterm.js session survives switching panels. */}
        {canShell && (
          <div style={{ display: panel === 'shell' ? 'block' : 'none' }}>
            <p className="lead">
              An ephemeral, locked-down shell (python3) scoped to your domain&apos;s governed
              data. It starts when you open this tab, stays connected while you move around
              the OS, and is destroyed when you sign out (or after a generous idle window).
              It cannot reach the cluster API, read secrets, or the public internet.
            </p>
            <Terminal />
          </div>
        )}

        {/* Query panel — governed, builder+. Unmount/remount is fine; no
            persistent connection. Always shown for builders (no Shell). */}
        {panel === 'query' && <AdminQueryContent canCube={canShell} />}
      </div>
    </>
  );
}
