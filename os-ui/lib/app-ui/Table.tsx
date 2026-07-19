/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import * as React from 'react';
import { cx } from './cx.ts';

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
