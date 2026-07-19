/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import * as React from 'react';
import { cx } from './cx.ts';

export type SectionProps = React.HTMLAttributes<HTMLDivElement> & {
  /** Gold eyebrow title with the trailing hairline. Omit for an untitled block. */
  title?: React.ReactNode;
  /** Props for the <div> that wraps `title` (rarely needed). */
  titleClassName?: string;
};

/** A titled content block — the OS's gold-eyebrow section header + its body. */
export function Section({ title, titleClassName, className, children, ...rest }: SectionProps) {
  return (
    <div className={cx(className)} {...rest}>
      {title != null && <div className={cx('sb-section-title', titleClassName)}>{title}</div>}
      {children}
    </div>
  );
}

export type PanelProps = React.HTMLAttributes<HTMLDivElement>;

/** A calm bordered panel — the neutral container used across the OS. */
export function Panel({ className, ...rest }: PanelProps) {
  return <div className={cx('sb-panel-box', className)} {...rest} />;
}
