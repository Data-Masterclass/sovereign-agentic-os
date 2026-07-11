/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@/components/PageHeader';
import GovernedConnections from '@/components/GovernedConnections';
import TalkTo from '@/components/talk/TalkTo';
import { TALK_PRESENTATION } from '@/lib/talk/schema';

/**
 * The Connections page — one scroll, no sub-tabs.
 *
 *   Top:    governed connections grouped All · My · Shared · Marketplace.
 *   Below:  create a new connection (OAuth templates + service connectors).
 *   Then:   app MCP connections (auto-generated) + supported connector catalog.
 *   Then:   outbound access (egress allowlist requests).
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
