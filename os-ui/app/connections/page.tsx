/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@/components/PageHeader';
import GovernedConnections from '@/components/GovernedConnections';
import TalkTo from '@/components/talk/TalkTo';
import { TALK_PRESENTATION } from '@/lib/talk/schema';

/**
 * The Connections page — one scroll, no sub-tabs. Four sections, top → bottom:
 *
 *   1. Connections list — governed connections grouped All · My · Shared · Marketplace,
 *      with App-MCP connections folded in by scope (header: scope segment · Show archived
 *      · ＋ New connector). Both create paths open the shared ConnectorWizard.
 *   2. Supported Connectors — a gallery of connector types (dynamic, from the registry).
 *   3. Outbound access — egress allowlist requests (Builder/Admin).
 *   4. Talk to Connectors — the metadata-grounded copilot for this tab.
 */
export default function ConnectionsPage() {
  const talk = TALK_PRESENTATION.connections;
  return (
    <>
      <PageHeader title="Connections" crumb="external systems · governed connections" tutorial="connections" />
      <div className="content">
        <p className="lead">
          The external systems this domain brings in — databases, APIs and SaaS — registered as governed
          connections that expose <strong>APIs or MCPs as tools</strong> for your agents and software.
          Credentials go to the secrets store and are never exposed — you share <em>use</em>, never the
          secret, under policy.
        </p>
        <GovernedConnections />

        {/* Talk to Connections — metadata-grounded Q&A over connection capabilities. */}
        <div style={{ marginTop: 40 }}>
          <TalkTo tab="connections" title={talk.title} blurb={talk.blurb} examples={talk.examples} />
        </div>
      </div>
    </>
  );
}
