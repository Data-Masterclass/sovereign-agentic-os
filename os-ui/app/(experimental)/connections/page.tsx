/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@core/ui/PageHeader';
import GovernedConnections from '@tabs/connections/ui/GovernedConnections';

/**
 * The Connections page — the OS-wide View/Edit artifact model.
 *
 *   • list   — governed connections as tiles-in-folders, grouped All · My · Domain · Company,
 *              with App-MCP connections folded in by scope (header: scope segment · Show
 *              archived · ＋ New connection). Clicking a tile opens it in View.
 *   • builder — ＋ New connection opens a two-door TYPE CHOOSER ("Use a connector" gallery ·
 *              "Build a custom connector"), both landing in the configure (Edit) surface.
 *              An existing connection opens in VIEW (real status · what it connects to ·
 *              exposed capabilities · usage · Test), with Promote + lifecycle in the detail
 *              header and ✎ Edit (edit-scope gated) for the configure surface.
 */
export default function ConnectionsPage() {
  return (
    <>
      <PageHeader title="Connections" crumb="external systems · governed connections" />
      <div className="content">
        <p className="lead">
          The external systems this domain brings in — databases, APIs and SaaS — registered as governed
          connections that expose <strong>APIs or MCPs as tools</strong> for your agents and software.
          Credentials go to the secrets store and are never exposed — you share <em>use</em>, never the
          secret, under policy.
        </p>
        <GovernedConnections />
      </div>
    </>
  );
}
