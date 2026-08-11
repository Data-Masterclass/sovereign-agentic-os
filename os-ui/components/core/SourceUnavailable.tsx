/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

/**
 * SourceUnavailable — the ONE calm, honest "the thing this was built on is gone" inline
 * empty-state for the graceful lifecycle spine (0.6.98). When a consumer artifact's source
 * (a dataset demoted to Personal, archived, or deleted) can no longer be resolved, the
 * consumer renders THIS for the affected tile/panel while the rest of the surface renders
 * normally — a degradation, not a crash (belt-and-suspenders with app/error.tsx).
 *
 * Reusable + tab-agnostic: 0.6.98 applies it to Metrics + Dashboards (the reported crash
 * sites); a later 0.6.99 rolls it out to the remaining consumer tabs (Knowledge / Files /
 * Connections / Science / Agents), so it takes only a short reason + optional name.
 */

import { SOURCE_UNAVAILABLE_REASON } from '@/lib/core/source-availability';

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
