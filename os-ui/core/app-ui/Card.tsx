/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Card — a bordered panel with the OS hover accent
 * USER STORY: As an app builder I want a card container in the OS style so that grouped content
 *             looks consistent with the OS.
 * ARCHITECTURE:
 *   - Part of the `@sovereign-os/ui` package (`core/app-ui/`), re-exported from `index.ts`.
 *   - A `div` with the `.sb-card` class from `theme.css`; forwards `className` and div props.
 */
import * as React from 'react';
import { cx } from './cx';

export type CardProps = React.HTMLAttributes<HTMLDivElement>;

/** OS card — bordered panel with the gold hover accent. */
export function Card({ className, ...rest }: CardProps) {
  return <div className={cx('sb-card', className)} {...rest} />;
}
