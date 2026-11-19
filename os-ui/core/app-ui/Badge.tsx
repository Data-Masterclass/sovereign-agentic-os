/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Badge — a small status pill in one of five tones
 * USER STORY: As an app builder I want a status badge that matches the OS so that states such
 *             as ok, warning and error read the same across apps.
 * ARCHITECTURE:
 *   - Part of the `@sovereign-os/ui` package (`core/app-ui/`), re-exported from `index.ts`.
 *   - Maps the tone to a `.sb-*` class from `theme.css`; forwards `className` and span props.
 */
import * as React from 'react';
import { cx } from './cx';

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
