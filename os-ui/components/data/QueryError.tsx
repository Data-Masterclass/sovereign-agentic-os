/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import { friendlyTrinoError } from '@/lib/data/friendly-error';

/**
 * One error surface for the Data tab's governed-query failures. It leads with the
 * PLAIN sentence from {@link friendlyTrinoError} and tucks the raw Trino string
 * (query_id and all) behind a small "Show details" disclosure — developers keep
 * everything, first-time users read one clear line. A non-Trino app message passes
 * straight through, so this is safe to use anywhere a raw error was shown before.
 */
export default function QueryError({
  error,
  style,
}: {
  error: string;
  style?: React.CSSProperties;
}) {
  if (!error) return null;
  const { friendly, raw } = friendlyTrinoError(error);
  const hasDetail = raw.trim() !== friendly.trim();
  return (
    <div className="error" style={style}>
      <div>{friendly}</div>
      {hasDetail ? (
        <details style={{ marginTop: 6 }}>
          <summary className="muted" style={{ cursor: 'pointer', fontSize: 12 }}>Show details</summary>
          <pre className="mono" style={{ margin: '6px 0 0', fontSize: 12, whiteSpace: 'pre-wrap' }}>{raw}</pre>
        </details>
      ) : null}
    </div>
  );
}
