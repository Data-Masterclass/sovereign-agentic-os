/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    <TileBadges /> — the ONE badge line a tile adds
 * USER STORY: As a user looking at a wall of tiles I want to tell at a glance which of them the
 *             company actually runs. That was the complaint: everything on one screen with no
 *             differentiation.
 * ARCHITECTURE:
 *   - One line per tile. It reads the shared batched lifecycle cache itself, so a tile renders
 *     its own badge with no prop threaded down from its list — and the list's filter hook reads
 *     the same cache, so the two cost ONE request between them.
 *   - `audience` is opt-OUT: most tiles already render a visibility badge, which IS the audience
 *     badge. Rendering a second one would duplicate it, so those tiles pass `audience={false}`
 *     and the pair on screen stays exactly two.
 *   - All words, classes and tooltips come from `./badges.ts`; the lifecycle word from
 *     `./lifecycle-cache.ts`. This file holds no logic a test would want.
 */
'use client';

import { useEffect, useState } from 'react';
import type { LifecycleKind } from '@core/kernel/object-lifecycle';
import { lifecycleBadge, audienceBadge } from '@core/ui/lifecycle/badges';
import {
  lifecycleForTile,
  requestLifecycles,
  subscribeLifecycles,
} from '@core/ui/lifecycle/lifecycle-cache';

export default function TileBadges({
  kind,
  id,
  tier,
  audience = true,
}: {
  kind: LifecycleKind;
  id: string;
  /** Whatever this tab persists as its tier/visibility. Only needed when `audience` is on. */
  tier?: string;
  /** Off when the tile already renders its own visibility badge — never two of the same. */
  audience?: boolean;
}) {
  const [, bump] = useState(0);
  useEffect(() => {
    requestLifecycles(kind, [id]);
    return subscribeLifecycles(kind, () => bump((n) => n + 1));
  }, [kind, id]);

  const life = lifecycleBadge(lifecycleForTile(kind, id));
  const aud = audience ? audienceBadge(tier ?? '') : null;
  return (
    <>
      <span className={life.className} title={life.title}>
        {life.label}
      </span>
      {aud ? (
        <span className={aud.className} title={aud.title}>
          {aud.label}
        </span>
      ) : null}
    </>
  );
}
