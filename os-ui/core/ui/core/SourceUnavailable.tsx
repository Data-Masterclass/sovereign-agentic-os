/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    SourceUnavailable — the inline empty state shown when an artifact's source is gone
 * USER STORY: As a user opening a metric or dashboard whose dataset was demoted, archived or
 *             deleted I want that tile to say its source is unavailable so that the rest of the
 *             page still works instead of crashing.
 * ARCHITECTURE:
 *   - Part of the lifecycle work (0.6.98). Shows a heading (the optional `name`) and a reason,
 *     which defaults to `SOURCE_UNAVAILABLE_REASON` from `@core/kernel/source-availability`.
 *     `app/error.tsx` is the fallback for real crashes.
 *   - Not tied to any tab, but currently used only by `tabs/metrics/ui/MetricsRegistry.tsx` and
 *     `tabs/dashboards/ui/DashboardGrid.tsx`. The rollout to the other consumer tabs is not
 *     done yet.
 */
'use client';

import { SOURCE_UNAVAILABLE_REASON } from '@core/kernel/source-availability';

export default function SourceUnavailable({
  name,
  reason = SOURCE_UNAVAILABLE_REASON,
  compact = false,
}: {
  /** The consumer artifact's name — shown as the heading when given. */
  name?: string;
  /** Override the default reason (e.g. a more specific "metric X" note). */
  reason?: string;
  /** `compact` fills a dashboard panel tile; the default suits a full-width card. */
  compact?: boolean;
}) {
  return (
    <div
      className="stub-page"
      role="status"
      aria-live="polite"
      style={
        compact
          ? { padding: 20, minHeight: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, textAlign: 'center' }
          : { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }
      }
    >
      <span aria-hidden="true" style={{ fontSize: 22, opacity: 0.6 }}>⚠︎</span>
      <div style={{ fontWeight: 600, color: 'var(--text-muted)' }}>
        {name ? `“${name}” — source unavailable` : 'Source unavailable'}
      </div>
      <div className="hint" style={{ margin: 0, maxWidth: 340 }}>{reason}</div>
    </div>
  );
}
