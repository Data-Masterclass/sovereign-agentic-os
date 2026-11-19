/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Select — an OS-styled dropdown
 * USER STORY: As an app builder I want a dropdown that matches the OS inputs so that forms in my
 *             app look consistent.
 * ARCHITECTURE:
 *   - Part of the `@sovereign-os/ui` package (`core/app-ui/`), re-exported from `index.ts`.
 *   - Forwards ref and native select props; uses the `.sb-select` class from `theme.css`.
 */
import * as React from 'react';
import { cx } from './cx';

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

/** OS select — same field styling as Input, auto width. */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <select ref={ref} className={cx('sb-select', className)} {...rest}>
      {children}
    </select>
  );
});
