/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import Link from 'next/link';
import type { LauncherCard } from '@/lib/home/launcher';
import type { GoldenPathKey } from '@/lib/tutorials/types';
import TutorialLink from '@/components/tutorials/TutorialLink';
import PathIllustration from './illustrations';

/**
 * The illustrated golden-path launcher — Home's centerpiece. One card per path:
 * a custom illustration, a one-line explainer, a role-aware primary action that
 * deep-links into the tab's flow, and a "How it works" tutorial link. Paths the
 * viewer can't act on are explained-but-dimmed (still learnable). Server-rendered
 * from the pure launcher adapter — no client JS needed for the gallery itself.
 */
export default function HomeLauncher({ cards }: { cards: LauncherCard[] }) {
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
            <TutorialLink tutorial={c.id as GoldenPathKey} variant="card" />
          </div>
        </div>
      ))}
    </div>
  );
}
