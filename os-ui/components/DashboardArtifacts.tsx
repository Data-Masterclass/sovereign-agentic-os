/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
'use client';

import ArtifactPanel from '@/components/ArtifactPanel';

/** Client wrapper so the (server) Dashboards page can mount the artifact panel
 *  with a render function without violating the server→client props boundary. */
export default function DashboardArtifacts() {
  return (
    <ArtifactPanel
      type="dashboard"
      createLabel="Create dashboard"
      specFields={[
        { key: 'metrics', label: 'Metrics / cubes', placeholder: 'daily_revenue, gross_margin' },
        { key: 'url', label: 'Superset link (optional)', placeholder: 'https://…/superset/dashboard/3' },
      ]}
      renderSpec={(a) => {
        const m = String(a.spec?.metrics ?? '');
        const u = String(a.spec?.url ?? '');
        return m || u ? (
          <div className="muted mono" style={{ fontSize: 11 }}>
            {m ? <>metrics: {m}<br /></> : null}
            {u ? <a href={u} target="_blank" rel="noreferrer">open →</a> : null}
          </div>
        ) : null;
      }}
      intro={
        <p className="hint" style={{ marginTop: 0 }}>
          A dashboard artifact references metrics + an optional Superset link. Inline embedding is{' '}
          <strong>scaffolded in v1</strong>; for now the artifact captures the definition and links
          out to Superset.
        </p>
      }
    />
  );
}
