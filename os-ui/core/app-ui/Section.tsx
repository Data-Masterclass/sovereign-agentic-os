/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Section and Panel — a titled content block and a plain bordered container
 * USER STORY: As an app builder I want section headings and panels in the OS style so that my
 *             app's pages are structured like the OS's own pages.
 * ARCHITECTURE:
 *   - Part of the `@sovereign-os/ui` package (`core/app-ui/`), re-exported from `index.ts`.
 *   - Styling via `.sb-section-title` and `.sb-panel-box` in `theme.css`; forwards div props.
 */
import * as React from 'react';
import { cx } from './cx';

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
