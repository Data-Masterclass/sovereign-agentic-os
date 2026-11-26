/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    TableScroll — the one scroll container a wide table sits in
 * USER STORY: As a user on a phone I want a wide table to scroll sideways inside its own box,
 *             so that the page itself never scrolls horizontally and the rest stays readable.
 * ARCHITECTURE:
 *   - Renders the existing `.table-wrap` box (app/styles/tokens-base.css: border, radius,
 *     overflow:auto) — overflow lives on the WRAPPER, never on body or `.main`.
 *   - The wrapper is a labelled, focusable region so a keyboard user can scroll it with the
 *     arrow keys (a scrollable region must be reachable — WCAG 2.1.1).
 *   - Cells keep the global `td { white-space: nowrap }`; the scroll is the answer to width, not
 *     wrapping. Pages adopt it in phone-screens step 3; bare tables are caught meanwhile by the
 *     phone safety net in app/styles/mobile.css.
 */
import type { CSSProperties, ReactNode } from 'react';

export default function TableScroll({
  label,
  children,
  className,
  style,
}: {
  /** Accessible name of the scroll region, e.g. "Run history". */
  label: string;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`table-wrap${className ? ` ${className}` : ''}`}
      role="region"
      aria-label={label}
      tabIndex={0}
      style={style}
    >
      {children}
    </div>
  );
}
