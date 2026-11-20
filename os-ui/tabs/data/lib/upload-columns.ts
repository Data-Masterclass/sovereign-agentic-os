/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Upload column mapping — every source header lands under a safe, stable identifier
 * USER STORY: As someone uploading a CSV with headers like `Order Date`, `größe` or `kunden-nr` I
 *             want the upload to just work — never to be told to rename my columns — and the
 *             original header kept and shown, so the table is usable in SQL and dbt as it is.
 * ARCHITECTURE:
 *   - Pure. `uploadHeaders` reads the header record of a delimited upload exactly as the
 *     data-runner does (Python `csv` reader: RFC 4180 quoting, `utf-8-sig` BOM, `,` or TAB for
 *     `.tsv`). `planUploadColumns` maps the headers through `literal.allocateColumnNames`: a header
 *     the dataset already knows keeps its stored name (recorded once, never re-derived); a new one
 *     is normalised (`literal.normalizeColumnName`, documented there), collisions get `_2`, `_3`.
 *   - The data-runner applies the names POSITIONALLY (`columnNames`) before it writes Bronze, and
 *     refuses a list that does not fit the file — so nothing is written under the wrong names.
 *   - Parquet / JSON carry their own column names; they are not mapped here (an existing such
 *     name stays as it is and is emitted quoted).
 */
import { allocateColumnNames, wellFormed } from '@tabs/data/lib/dbt/literal';
import type { ColumnDoc } from '@tabs/data/lib/dataset-schema';

/** The header names of a delimited upload, or null when the format carries its own schema. */
export function uploadHeaders(fileName: string, body: Buffer): string[] | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.parquet') || lower.endsWith('.json') || lower.endsWith('.ndjson')) return null;
  const delimiter = lower.endsWith('.tsv') ? '\t' : ',';
  const text = body.toString('utf8').replace(/^\uFEFF/, '');
  const out: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      out.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') break;
    else field += ch;
  }
  if (out.length || field || i > 0) out.push(field);
  return out.length === 1 && out[0] === '' ? [] : out.map(wellFormed);
}

/** The positional names the data-runner lands, and the column docs the OS records. */
export function planUploadColumns(headers: string[], existing: ColumnDoc[]): { columnNames: string[]; columns: ColumnDoc[] } {
  const plan = allocateColumnNames(headers, existing);
  return {
    columnNames: plan.map((p) => p.name),
    columns: plan.map((p) => ({ name: p.name, description: '', ...(p.source !== p.name ? { source: p.source } : {}) })),
  };
}

/**
 * The column docs to record from what the runner LANDED. A landed name the plan produced carries
 * its source header; any other landed name (an older runner that ignored `columnNames`, or the
 * retry under the file's own names) is recorded as it landed — a valid physical name either way.
 */
export function landedColumnDocs(landed: { name: string }[], plan: { columns: ColumnDoc[] } | null): ColumnDoc[] {
  const sourceOf = new Map((plan?.columns ?? []).filter((c) => c.source).map((c) => [c.name, c.source!]));
  return landed.map((c) => ({ name: c.name, description: '', ...(sourceOf.has(c.name) ? { source: sourceOf.get(c.name)! } : {}) }));
}
