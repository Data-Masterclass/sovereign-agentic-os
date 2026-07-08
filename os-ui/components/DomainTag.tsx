/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { CSSProperties } from 'react';

/**
 * DomainTag — the OS-wide source-domain provenance badge.
 *
 * Shown on any artifact displayed in a SHARED or MARKETPLACE scope (across every
 * tab), so two artifacts with the same name but from different domains are never
 * ambiguous. Reuses the existing `chip` styling for visual consistency. Renders
 * nothing when there is no domain (e.g. a personal item), so it is always safe to
 * drop into a tile/detail unconditionally in Shared/Marketplace contexts.
 */
export default function DomainTag({
  domain,
  style,
  className = '',
}: {
  domain?: string | null;
  style?: CSSProperties;
  className?: string;
}) {
  const d = (domain ?? '').trim();
  if (!d) return null;
  return (
    <span
      className={`chip domain-tag ${className}`.trim()}
      title={`Source domain: ${d}`}
      style={{ fontSize: 11, opacity: 0.85, ...style }}
    >
      ⌂ {d}
    </span>
  );
}
