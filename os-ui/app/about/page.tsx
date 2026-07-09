/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 */
import PageHeader from '@/components/PageHeader';
import { byLicense, COMPONENTS, TRADEMARK_NOTE } from '@/lib/core/licenses';
import { currentUser } from '@/lib/core/auth';

// Server component: the About / Licenses page. Admin-only (Platform group).
// Lists every bundled component grouped by SPDX license, with the trademark +
// affiliation note. Mirrors the authoritative THIRD-PARTY-LICENSES.md.

export default async function AboutPage() {
  const user = await currentUser();
  if (!user || user.role !== 'admin') {
    return (
      <>
        <PageHeader title="About / Licenses" crumb="open-source components & their licenses" />
        <div className="content">
          <div className="stub-page" style={{ marginTop: 20 }}>
            This area is for platform administrators. You are signed in as a{' '}
            <strong>{user?.role ?? 'guest'}</strong>.
          </div>
        </div>
      </>
    );
  }
  const groups = byLicense();
  return (
    <>
      <PageHeader title="About / Licenses" crumb="open-source components & their licenses" />
      <div className="content">
        <p className="lead">
          The Sovereign Agentic OS is assembled from ~30 best-in-class open-source tools. The
          core is licensed <strong>Apache-2.0</strong>; each bundled component keeps its own
          license, listed below across {COMPONENTS.length} components in {groups.length}{' '}
          license families.
        </p>

        {groups.map((g) => (
          <div key={g.license}>
            <div className="section-title">
              {g.license}
              <span className="count-pill">{g.items.length}</span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Component</th>
                    <th>Layer</th>
                    <th>Role</th>
                  </tr>
                </thead>
                <tbody>
                  {g.items.map((c) => (
                    <tr key={c.name}>
                      <td style={{ fontWeight: 600 }}>{c.name}</td>
                      <td className="muted">{c.layer}</td>
                      <td className="muted" style={{ whiteSpace: 'normal', maxWidth: 460 }}>
                        {c.note}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        <div className="section-title">Notice</div>
        <div className="answer" style={{ fontSize: 13 }}>
          {TRADEMARK_NOTE}
        </div>
        <div className="hint">
          This list mirrors the repository&apos;s authoritative{' '}
          <code>THIRD-PARTY-LICENSES.md</code>. SPDX identifiers are used throughout. Report
          discrepancies to the platform team.
        </div>
      </div>
    </>
  );
}
