/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import * as React from 'react';
import { cx } from './cx.ts';

export type BadgeTone = 'default' | 'ok' | 'warn' | 'err' | 'muted';

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
};

const TONE: Record<BadgeTone, string> = {
  default: '',
  ok: 'sb-ok',
  warn: 'sb-warn',
  err: 'sb-err',
  muted: 'sb-muted',
};

/** OS status badge — uppercase Oswald pill in the tone's brand colour. */
export function Badge({ tone = 'default', className, ...rest }: BadgeProps) {
  return <span className={cx('sb-badge', TONE[tone], className)} {...rest} />;
}
