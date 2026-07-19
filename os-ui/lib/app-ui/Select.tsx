/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import * as React from 'react';
import { cx } from './cx.ts';

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
