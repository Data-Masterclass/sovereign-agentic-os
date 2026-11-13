/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
'use client';

import type { ChatArtifact } from '@core/runtime/chat-artifacts';
import {
  citationDetail,
  citationHref,
  citationLabel,
  clampCell,
  deferredNote,
  splitArtifacts,
  tableView,
} from '@core/ui/ask-artifacts';

/**
 * FEATURE:    The Ask-the-OS artifact renderers — `table` and `citation` (C9).
 *
 * USER STORY: As a user I want the answer to carry the rows it is about, the SQL or metric
 *             that produced them, a verbatim banner when the backend clipped the result, and
 *             a chip naming the governed record — so I can check the answer instead of
 *             trusting it.
 *
 * ARCHITECTURE:
 *   A SHELL. Every decision lives in `core/ui/ask-artifacts.ts` so it is unit-testable (a
 *   test cannot import a `.tsx`). This file only maps that decision onto elements, and it
 *   extends the existing tool-chip mechanism in `OsAssistant.tsx` rather than introducing a
 *   second message surface.
 *
 *   SECURITY, non-negotiable and asserted by `core/ui/ask-artifacts-guard.test.ts`:
 *     • No `dangerouslySetInnerHTML`, no `eval`, no `new Function` anywhere on this path.
 *     • Every value is rendered as a TEXT NODE ({children}) — never as markup, never as a
 *       URL, never as a style. A cell containing `<img src=x onerror=…>` renders as those
 *       characters, which is the whole point.
 *     • No model-authored HTML, SVG or JS is rendered. An artifact carries data only; the
 *       model never emits markup, and a kind this build cannot render is counted, not run.
 *     • A `citation` link target comes from a fixed in-app route map, never from the
 *       artifact — a model-supplied href is an open redirect waiting to happen.
 */

export default function AskArtifacts({ artifacts }: { artifacts: ChatArtifact[] }) {
  if (!artifacts || artifacts.length === 0) return null;
  const { tables, citations, deferred } = splitArtifacts(artifacts);
  const note = deferredNote(deferred);
  if (tables.length === 0 && citations.length === 0 && !note) return null;

  return (
    <div className="osa-artifacts">
      {tables.map((t, i) => {
        const v = tableView(t);
        return (
          <figure className="osa-artifact" key={`t${i}`}>
            <figcaption className="osa-artifact-head">
              <span className="osa-artifact-title">{v.title}</span>
              <span className={`chip osa-source${v.sourceCaveat ? ' blocked' : ''}`}>{v.sourceLabel}</span>
              {v.mode ? <span className="chip osa-mode">mode: {v.mode}</span> : null}
            </figcaption>

            {/* The backend's OWN truncation sentence, verbatim. Shown ABOVE the rows so it
                cannot be read as a footnote to a total. */}
            {v.banner ? (
              <p className="error osa-truncated" role="status">
                {v.banner}
              </p>
            ) : null}

            {/* The tool's own degradation sentence — a dropped slice member, a pending
                window metric, an unreachable lakehouse. Its own line, never merged with
                the truncation banner above. */}
            {v.warning ? (
              <p className="error osa-warning" role="status">
                {v.warning}
              </p>
            ) : null}

            {v.sourceCaveat ? <p className="hint osa-caveat">{v.sourceCaveat}</p> : null}

            {v.columns.length === 0 && v.rows.length === 0 ? (
              <p className="muted osa-empty">No rows.</p>
            ) : (
              <div className="osa-table-wrap">
                <table className="osa-table">
                  <thead>
                    <tr>
                      {v.columns.map((c, j) => (
                        <th key={j} scope="col">
                          {clampCell(c, 64).text}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {v.rows.map((row, r) => (
                      <tr key={r}>
                        {row.map((value, c) => {
                          const { text, clamped } = clampCell(value);
                          // `title` is a plain attribute carrying the full value as text —
                          // no markup is interpreted, here or anywhere on this path.
                          return (
                            <td key={c} title={clamped ? value : undefined}>
                              {text}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <p className="hint osa-rowcount">
              {v.rowCount} row{v.rowCount === 1 ? '' : 's'} returned.
              {v.viewNote ? ` ${v.viewNote}` : ''}
            </p>

            {v.sql ? (
              <details className="osa-sql">
                <summary>The SQL that ran</summary>
                <pre>
                  <code>{v.sql}</code>
                </pre>
              </details>
            ) : null}
            {v.semanticQuery ? (
              <details className="osa-sql">
                <summary>The semantic query that ran</summary>
                <pre>
                  <code>{v.semanticQuery}</code>
                </pre>
              </details>
            ) : null}
          </figure>
        );
      })}

      {citations.length > 0 ? (
        <div className="osa-citations" aria-label="What this answer is grounded in">
          {citations.map((c, i) => {
            const href = citationHref(c);
            const detail = citationDetail(c);
            const label = citationLabel(c);
            const body = (
              <>
                {label}
                {detail ? <span className="osa-cite-detail"> · {detail}</span> : null}
              </>
            );
            // The href comes from our fixed route map, never from the artifact.
            return href ? (
              <a className="chip osa-cite" key={`c${i}`} href={href}>
                {body}
              </a>
            ) : (
              <span className="chip osa-cite" key={`c${i}`}>
                {body}
              </span>
            );
          })}
        </div>
      ) : null}

      {note ? <p className="hint osa-deferred">{note}</p> : null}
    </div>
  );
}
