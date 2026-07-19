/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import * as React from 'react';
import { cx } from './cx.ts';

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  /** 'primary' = brand gold gradient (default); 'ghost' = secondary. */
  variant?: 'primary' | 'ghost';
  /** Compact height. */
  size?: 'md' | 'sm';
};

/**
 * OS button. Gold gradient by default, ghost variant for secondary actions.
 * `className` is appended so callers can override freely.
 */
export function Button({ variant = 'primary', size = 'md', className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? 'button'}
      className={cx('sb-btn', variant === 'ghost' && 'sb-ghost', size === 'sm' && 'sb-sm', className)}
      {...rest}
    />
  );
}
