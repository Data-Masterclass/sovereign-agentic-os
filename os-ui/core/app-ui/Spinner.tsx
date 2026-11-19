/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Spinner — a small loading indicator
 * USER STORY: As an app builder I want a loading spinner so that users see that data is still
 *             loading.
 * ARCHITECTURE:
 *   - Part of the `@sovereign-os/ui` package (`core/app-ui/`), re-exported from `index.ts`.
 *   - Inline styles plus the `sb-spin` keyframe from `theme.css`; `role="status"` for screen readers.
 */
import * as React from 'react';
import { cx } from './cx';

export type SpinnerProps = React.HTMLAttributes<HTMLSpanElement> & {
  /** Diameter in px. Defaults to 18. */
  size?: number;
};

/**
 * A minimal, dependency-free loading spinner. Uses the `sb-spin` keyframe from
 * `theme.css` (always imported as a side-effect). Forwards `className` + props.
 */
export function Spinner({ size = 18, className, style, ...rest }: SpinnerProps) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cx('sb-spinner', className)}
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: '2px solid currentColor',
        borderRightColor: 'transparent',
        borderRadius: '50%',
        opacity: 0.55,
        animation: 'sb-spin 0.6s linear infinite',
        ...style,
      }}
      {...rest}
    />
  );
}
