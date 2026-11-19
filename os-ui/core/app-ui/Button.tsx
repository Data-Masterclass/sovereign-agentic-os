/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Button — the OS button with a primary (gold) and a ghost variant
 * USER STORY: As an app builder I want an OS-styled button so that actions in my app look and
 *             behave like the OS's own buttons.
 * ARCHITECTURE:
 *   - Part of the `@sovereign-os/ui` package (`core/app-ui/`), re-exported from `index.ts`.
 *   - Defaults `type` to `button` (not submit); styling via `.sb-btn` classes in `theme.css`.
 */
import * as React from 'react';
import { cx } from './cx';

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
