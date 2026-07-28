/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import * as React from 'react';
import { cx } from './cx.ts';

export type AlertVariant = 'info' | 'success' | 'warning' | 'error';

export type AlertProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Visual tone. Defaults to `info`. */
  variant?: AlertVariant;
};

const TONE: Record<AlertVariant, string> = {
  info: '#175cd3',
  success: '#067647',
  warning: '#b54708',
  error: '#b42318',
};

/**
 * A calm inline alert box for loading errors and notices. Self-contained styles
 * (no theme-class dependency); forwards `className` + native div props.
 */
export function Alert({ variant = 'info', className, style, children, ...rest }: AlertProps) {
  const tone = TONE[variant];
  return (
    <div
      role="alert"
      className={cx('sb-alert', className)}
      style={{
        border: `1px solid ${tone}33`,
        background: `${tone}14`,
        color: tone,
        borderRadius: 8,
        padding: '8px 12px',
        fontSize: 13,
        lineHeight: 1.5,
        ...style,
      }}
      {...rest}
    >
      {children}
    </div>
  );
}
