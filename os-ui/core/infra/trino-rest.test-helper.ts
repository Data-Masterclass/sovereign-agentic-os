/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TEST-ONLY: drive a real Trino with its documented client REST protocol
 * (https://trino.io/docs/476/develop/client-protocol.html: POST /v1/statement, follow nextUri).
 * Used by the `*.trino.test.ts` files, which run against the lakehouse harness
 * (tests/lakehouse/up.sh) and skip when `LH_TRINO_URL` is unset.
 */
export const LH_TRINO_URL = process.env.LH_TRINO_URL ?? '';

export type TrinoFailure = Error & { errorName?: string; errorType?: string };

/** Run one statement AS `user`; resolves to columns + rows, rejects with Trino's own error. */
export async function trino(sql: string, user: string): Promise<{ columns: string[]; rows: unknown[][] }> {
  const headers = { 'X-Trino-User': user, 'X-Trino-Source': 'os-ui-it', 'Content-Type': 'text/plain' };
  let r = (await (await fetch(`${LH_TRINO_URL}/v1/statement`, { method: 'POST', headers, body: sql })).json()) as Record<string, any>;
  const rows: unknown[][] = [];
  let columns: string[] = [];
  for (;;) {
    if (r.error) {
      const e = new Error(`${r.error.errorName}: ${r.error.message}`) as TrinoFailure;
      e.errorName = r.error.errorName;
      e.errorType = r.error.errorType;
      throw e;
    }
    if (r.columns) columns = r.columns.map((c: { name: string }) => c.name);
    if (r.data) rows.push(...r.data);
    if (!r.nextUri) return { columns, rows };
    r = (await (await fetch(r.nextUri, { headers })).json()) as Record<string, any>;
  }
}
