/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       ui
 * FEATURE:    <AudienceBadge /> — My · Domain · Company
 * USER STORY: As a user I want to see who may use an artefact, beside whether it is running —
 *             two facts, two badges, never one word standing for both.
 * ARCHITECTURE: A shell over `./badges.ts`. It takes whatever tier its tab persists and maps it
 *               for DISPLAY; it changes nothing about the promotion ladder.
 */
'use client';

import { audienceBadgeMessage, renderBadge } from '@core/ui/lifecycle/badges';
import { useCommonMessage } from '@core/ui/useScopeLabel';

export default function AudienceBadge({ tier }: { tier: string }) {
  const text = useCommonMessage();
  const b = renderBadge(audienceBadgeMessage(tier), text);
  return (
    <span className={b.className} title={b.title}>
      {b.label}
    </span>
  );
}
