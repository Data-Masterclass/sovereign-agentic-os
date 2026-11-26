/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home "top items per artifact" board
 * USER STORY: As a user I want a short list of my most notable datasets, metrics, agents and other items,
 *             each linking into its tab, so that I can get back to my work quickly.
 * ARCHITECTURE:
 *   - Server component that renders the groups `scope.topItems` built from rows already scoped to
 *     the viewer in `tabs/home/lib/feed.ts`. Shows an empty state when there are none.
 *   - Not imported anywhere at present: `homeFeed()` still computes `topItems`, but no page
 *     renders this board.
 * I18N:       converted (wave 2) — strings from the `home` namespace (`home.top.*`); group names by their key.
 *             A row's meta line (visibility · domain) is the registry's own value and is shown as is.
 */
import Link from 'next/link';
import { useTranslations } from '@core/i18n/client';
import type { TopGroup } from '@tabs/home/lib/scope';

/**
 * "Top items per artifact" — a scannable board of the viewer's most-notable
 * entries per registry type (datasets, metrics, dashboards, agents, knowledge,
 * files, connections, software). Every row deep-links

 * into its owning tab. The data is OPA/RLS-scoped upstream (lib/home/feed →
 * scope.topItems), so nothing cross-domain or another user's Personal item can
 * appear. Empty types are omitted; a fresh tenant shows an honest empty state.
 */
const GROUP_KEYS = ['dataset', 'transformation', 'metric', 'dashboard', 'agent', 'knowledge', 'file', 'connection', 'software'] as const;
type GroupKey = (typeof GROUP_KEYS)[number];
const isGroupKey = (k: string): k is GroupKey => (GROUP_KEYS as readonly string[]).includes(k);

export default function TopItems({ groups }: { groups: TopGroup[] }) {
  const t = useTranslations('home');
  const label = (g: TopGroup) => (isGroupKey(g.key) ? t(`top.groups.${g.key}`) : g.label);
  if (groups.length === 0) {
    return (
      <div className="ci-empty">
        <div className="ci-empty-mark" aria-hidden="true">
          ◇
        </div>
        <div>
          <div className="ci-empty-title">{t('top.emptyTitle')}</div>
          <p className="ci-empty-sub">{t('top.emptySub')}</p>
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
            <h3 className="ci-card-title">{label(g)}</h3>
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
              {t('top.more', { count: g.count - g.items.length, group: label(g) })}
            </Link>
          ) : (
            <Link href={g.tab} className="ci-more ci-more-all">
              {t('top.open', { group: label(g) })}
            </Link>
          )}
        </section>
      ))}
    </div>
  );
}
