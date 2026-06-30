/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import Link from 'next/link';
import type { TopGroup } from '@/lib/home/scope';

/**
 * "Top items per artifact" — a scannable board of the viewer's most-notable
 * entries per registry type (datasets, metrics, dashboards, agents, knowledge,
 * files, connections, software, big bets, strategy pillars). Every row deep-links
 * into its owning tab. The data is OPA/RLS-scoped upstream (lib/home/feed →
 * scope.topItems), so nothing cross-domain or another user's Personal item can
 * appear. Empty types are omitted; a fresh tenant shows an honest empty state.
 */
export default function TopItems({ groups }: { groups: TopGroup[] }) {
  if (groups.length === 0) {
    return (
      <div className="ci-empty">
        <div className="ci-empty-mark" aria-hidden="true">
          ◇
        </div>
        <div>
          <div className="ci-empty-title">Nothing in your registry yet</div>
          <p className="ci-empty-sub">
            As you and your domain create datasets, metrics, agents and more, your most-notable items
            will gather here — each linking straight into its tab. Start from a golden path on Home.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="ci-board">
      {groups.map((g) => (
        <section className="ci-card" key={g.key}>
          <div className="ci-card-head">
            <span className="ci-card-icon" aria-hidden="true">
              {g.icon}
            </span>
            <h3 className="ci-card-title">{g.label}</h3>
            <span className="ci-card-count">{g.count}</span>
          </div>
          <ul className="ci-list">
            {g.items.map((it) => (
              <li key={it.id} className="ci-row">
                <Link href={it.href} className="ci-row-link">
                  <span className={`ci-dot ${it.tone}`} aria-hidden="true" />
                  <span className="ci-row-text">
                    <span className="ci-row-name">{it.name}</span>
                    <span className="ci-row-meta">{it.meta}</span>
                  </span>
                  <span className="ci-row-go" aria-hidden="true">
                    →
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {g.count > g.items.length ? (
            <Link href={g.tab} className="ci-more">
              +{g.count - g.items.length} more in {g.label}
            </Link>
          ) : (
            <Link href={g.tab} className="ci-more ci-more-all">
              Open {g.label}
            </Link>
          )}
        </section>
      ))}
    </div>
  );
}
