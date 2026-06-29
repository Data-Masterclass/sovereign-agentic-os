/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import PageHeader from '@/components/PageHeader';
import DashboardArtifacts from '@/components/DashboardArtifacts';
import ToolEmbed from '@/components/ToolEmbed';
import { config } from '@/lib/config';

// Server component: renders the (client) artifact workspace for dashboards and
// hands the browser a plain Superset link (Superset has its own auth + session).
//
// force-dynamic so the Superset console URL is read from the RUNTIME env
// (SUPERSET_URL, e.g. the public ingress host) at request time. Without this,
// Next prerenders this page at build time and bakes in the localhost default
// from config.ts — making the deployed "Open" link point at localhost.
export const dynamic = 'force-dynamic';

export default function DashboardsPage() {
  const url = config.supersetUrl;
  return (
    <>
      <PageHeader title="Dashboards" crumb="dashboard artifacts + Superset BI on Cube metrics" />
      <div className="content">
        <p className="lead">
          Compose dashboards over your governed metrics. Author a dashboard artifact (Personal →
          Shared → Certified), or open Superset to build interactively.
        </p>

        <DashboardArtifacts />

        <div className="section-title" style={{ marginTop: 28 }}>Superset BI — embedded</div>
        <ToolEmbed
          url={url}
          title="Superset"
          note="The Sales Overview dashboard is built on the Cube Revenue metric — the same numbers the Sales agent returns."
        />
        <div className="hint">
          Set <code>SUPERSET_URL</code> to your Superset address (default <code>http://localhost:8088</code>).
        </div>
      </div>
    </>
  );
}
