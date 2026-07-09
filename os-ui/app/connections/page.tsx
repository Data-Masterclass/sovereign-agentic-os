/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import PageHeader from '@/components/PageHeader';
import GovernedConnections from '@/components/GovernedConnections';

/**
 * The Connections page — one scroll, no sub-tabs.
 *
 *   Top:    governed connections grouped All · My · Shared · Marketplace.
 *   Below:  create a new connection (OAuth templates + service connectors).
 *   Then:   app MCP connections (auto-generated) + supported connector catalog.
 *   Then:   outbound access (egress allowlist requests).
 */
export default function ConnectionsPage() {
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
      </div>
    </>
  );
}
