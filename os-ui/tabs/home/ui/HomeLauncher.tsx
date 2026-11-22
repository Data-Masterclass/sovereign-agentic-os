/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Home launcher gallery — one illustrated card per golden path
 * USER STORY: As a user I want to see every golden path with a short explainer and one action button,
 *             so that I can start the right flow from Home.
 * ARCHITECTURE:
 *   - Server component, rendered by `app/page.tsx` from the cards `tabs/home/lib/launcher` resolves.
 *   - Cards the viewer cannot act on are dimmed and link to "Explore" instead of the action.
 */
import Link from 'next/link';
import type { LauncherCard } from '@tabs/home/lib/launcher';
import PathIllustration from '@tabs/home/ui/illustrations';

/**
 * The illustrated golden-path launcher — Home's centerpiece. One card per path:
 * a custom illustration, a one-line explainer, a role-aware primary action that
 * deep-links into the tab's flow. Paths the
 * viewer can't act on are explained-but-dimmed (still learnable). Server-rendered
 * from the pure launcher adapter — no client JS needed for the gallery itself.
 */
export default function HomeLauncher({ cards, compact = false }: { cards: LauncherCard[]; compact?: boolean }) {
  if (compact) {
    // One row of small chips: title + action, no illustration, so the chat keeps the space.
    return (
      <nav className="launch-strip" aria-label="Golden paths">
        {cards.map((c) => (
          <Link key={c.id} href={c.href} className={`launch-chip${c.canAct ? '' : ' is-dim'}`} title={c.dimmedReason ?? c.blurb}>
            <span className="launch-chip-title">{c.title}</span>
            <span className="launch-chip-go">{c.canAct ? c.actionLabel : 'Explore'}</span>
          </Link>
        ))}
      </nav>
    );
  }
  return (
    <div className="launch-gallery">
      {cards.map((c) => (
        <div key={c.id} className={`launch-tile${c.canAct ? '' : ' is-dim'}`}>
          <div className="launch-art">
            <PathIllustration id={c.art} />
          </div>
          <div className="launch-meta">
            <h3 className="launch-title">{c.title}</h3>
            <p className="launch-blurb">{c.blurb}</p>
            {!c.canAct && c.dimmedReason ? (
              <p className="launch-dim-note">{c.dimmedReason}</p>
            ) : null}
          </div>
          <div className="launch-actions">
            {c.canAct ? (
              <Link className="launch-go" href={c.href}>
                {c.actionLabel}
                <span aria-hidden="true"> →</span>
              </Link>
            ) : (
              <Link className="launch-go is-muted" href={c.href}>
                Explore
                <span aria-hidden="true"> →</span>
              </Link>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}
