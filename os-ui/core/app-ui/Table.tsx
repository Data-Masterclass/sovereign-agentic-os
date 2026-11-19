/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Table — a bordered, scrollable table wrapper with the OS header style
 * USER STORY: As an app builder I want an OS-styled table so that lists of records in my app
 *             look like the OS's tables.
 * ARCHITECTURE:
 *   - Part of the `@sovereign-os/ui` package (`core/app-ui/`), re-exported from `index.ts`.
 *   - Wraps a native `<table>` in a `.sb-table-wrap` div; callers supply `<thead>` / `<tbody>`.
 */
import * as React from 'react';
import { cx } from './cx';

export type TableProps = React.TableHTMLAttributes<HTMLTableElement> & {
  /** Wrapper div props (the bordered, scrollable container). */
  wrapClassName?: string;
};

/**
 * OS table — a bordered, scrollable wrapper with the sticky gold header.
 * Compose the usual <thead>/<tbody> inside.
 */
export function Table({ className, wrapClassName, children, ...rest }: TableProps) {
  return (
    <div className={cx('sb-table-wrap', wrapClassName)}>
      <table className={cx('sb-table', className)} {...rest}>
        {children}
      </table>
    </div>
  );
}
