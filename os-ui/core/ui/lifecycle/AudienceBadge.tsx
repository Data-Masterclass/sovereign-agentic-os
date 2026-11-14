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
import { audienceBadge } from '@core/ui/lifecycle/badges';

export default function AudienceBadge({ tier }: { tier: string }) {
  const b = audienceBadge(tier);
  return (
    <span className={b.className} title={b.title}>
      {b.label}
    </span>
  );
}
