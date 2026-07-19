/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import * as React from 'react';
import { cx } from './cx.ts';

export type CardProps = React.HTMLAttributes<HTMLDivElement>;

/** OS card — bordered panel with the gold hover accent. */
export function Card({ className, ...rest }: CardProps) {
  return <div className={cx('sb-card', className)} {...rest} />;
}
