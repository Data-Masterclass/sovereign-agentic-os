/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    `<ReleaseList/>` — an app's release tags, or nothing at all
 * USER STORY: As someone looking at an app I want to see which versions were released, as the
 *             annotated tags they really are (`app/<slug>/v1.2.0`), and to see NO release panel
 *             at all when this build cannot read tags — rather than an empty one that reads as
 *             "never released" (checklist G10).
 * ARCHITECTURE:
 *   - A SHELL over `git-view.ts` `releaseListView`, which decides visible/hidden and formats the
 *     rows. The data comes from `/api/git?action=releases`, which answers `available: false` with
 *     a reason while the annotated-tag half of the git store is another stream's work in flight.
 *   - Hidden means hidden: an unavailable tag API renders nothing, never a claim.
 */
'use client';

import { useEffect, useState } from 'react';
import { releaseListView, type ReleaseView } from '@core/ui/git/git-view';

export default function ReleaseList({ kind, id }: { kind: string; id: string }) {
  const [state, setState] = useState<{ available: boolean; releases: ReleaseView[] } | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const params = new URLSearchParams({ action: 'releases', kind, id });
        const res = await fetch(`/api/git?${params.toString()}`, { cache: 'no-store' });
        const body = res.ok ? await res.json() : { available: false, releases: [] };
        if (alive) setState({ available: !!body.available, releases: (body.releases ?? []) as ReleaseView[] });
      } catch {
        if (alive) setState({ available: false, releases: [] });
      }
    })();
    return () => {
      alive = false;
    };
  }, [kind, id]);

  const view = releaseListView({ available: !!state?.available, releases: state?.releases ?? [] });
  if (!view.visible) return null;
  return (
    <section style={{ marginTop: 18 }}>
      <h3 style={{ fontSize: 14, margin: '0 0 6px' }}>Releases</h3>
      {view.note ? <div className="muted" style={{ fontSize: 12 }}>{view.note}</div> : null}
      {view.rows.length > 0 ? (
        <table className="tbl" style={{ fontSize: 12 }}>
          <thead>
            <tr>
              <th>Version</th>
              <th>Tag</th>
              <th>Commit</th>
              <th>By</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {view.rows.map((r) => (
              <tr key={r.tag}>
                <td>{r.version}</td>
                <td className="mono">{r.tag}</td>
                <td className="mono">{r.short}</td>
                <td>{r.author || '—'}</td>
                <td>{r.when || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
