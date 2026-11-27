/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    <LifecycleBadge /> — Draft · Testing · Live
 * USER STORY: As a user I want one small badge per tile telling me whether this is running.
 * ARCHITECTURE: A shell. Every word, class and tooltip comes from `./badges.ts`, which is what
 *               the tests import (a test cannot import a `.tsx`).
 */
'use client';

import { lifecycleBadgeMessage, renderBadge } from '@core/ui/lifecycle/badges';
import { useCommonMessage } from '@core/ui/useScopeLabel';
import type { Lifecycle } from '@core/kernel/object-lifecycle';

export default function LifecycleBadge({ lifecycle }: { lifecycle: Lifecycle }) {
  const text = useCommonMessage();
  const b = renderBadge(lifecycleBadgeMessage(lifecycle), text);
  return (
    <span className={b.className} title={b.title}>
      {b.label}
    </span>
  );
}
