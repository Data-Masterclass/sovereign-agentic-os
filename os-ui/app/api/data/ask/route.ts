/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { config } from '@/lib/config';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { listAskable } from '@/lib/data/store';
import { queryRun, trace } from '@/lib/governed';
import { liteLlmCaller } from '@/lib/assistant/runtime';
import { runAsk, type AskMessage } from '@/lib/data/ask';

export const dynamic = 'force-dynamic';

/**
 * Talk-to-your-data v2 (NL→SQL). The browser POSTs { question }; we:
 *   1. scope the LLM context to the registry docs of datasets the SESSION user
 *      canView (`listAskable`) — never another user's schema/docs;
 *   2. have LiteLLM generate ONE read-only SELECT, validated before execution
 *      (single statement, SELECT-only, no comments — see lib/data/ask.ts);
 *   3. execute it via the governed `queryRun(sql, principal)` so Trino→OPA row
 *      filters + column masks apply to the answer automatically;
 *   4. ground the natural-language answer ONLY in the returned rows;
 *   5. trace the turn to Langfuse like every other governed data-tool call.
 * The principal is ALWAYS derived from the session (requirePrincipal) — the
 * request body carries only the question. Anonymous callers get 401.
 */
export async function POST(req: Request) {
  try {
    const user = await requirePrincipal(); // 401 for anon (+ registry hydration)

    let question = '';
    try {
      const body = await req.json();
      question = (body?.question ?? '').toString().trim();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!question) return NextResponse.json({ error: 'Missing question' }, { status: 400 });

    // The ONLY schema context the model sees: canView-scoped registry docs.
    const datasets = listAskable(user);

    // The principal Trino's OPA plugin governs row/column on — the caller's domain
    // (or their id). NEVER trusted from the request body. Same as /api/query.
    const principal = user.domains[0] ?? user.id;

    const call = liteLlmCaller();
    const result = await runAsk({
      question,
      datasets,
      llm: async (messages: AskMessage[], model: string) =>
        (await call({ model, messages, temperature: 0 })).content,
      models: {
        generate: config.litellmReasoningModel, // SQL needs the deep model
        summarize: config.litellmExecModel, // the grounded summary is light work
      },
      query: (sql) => queryRun(sql, principal),
    });

    // Audit the turn (best-effort, same pattern as the metrics/query tools).
    const traced = await trace({
      principal,
      tool: 'ask',
      input: { question, context: datasets.map((d) => d.fqn) },
      output: result.ok
        ? { sql: result.sql, rowCount: result.rowCount }
        : { kind: result.kind, error: result.message, sql: result.sql ?? null },
    });

    if (!result.ok) {
      // Honest failure states: no accessible dataset is a calm 200 answer (not an
      // error); invalid SQL (rejected, never executed) 422; a Trino/OPA refusal 502.
      const status = result.kind === 'no_dataset' ? 200 : result.kind === 'invalid_sql' ? 422 : 502;
      return NextResponse.json(
        { ok: false, kind: result.kind, error: result.message, sql: result.sql ?? null, traced },
        { status },
      );
    }
    return NextResponse.json({ ...result, traced });
  } catch (e) {
    // 401 for anon (thrown by requirePrincipal); otherwise surface a 400/502.
    const status = (e as { status?: number }).status;
    if (status) return errorResponse(e);
    return NextResponse.json({ error: `ask failed: ${(e as Error).message}` }, { status: 502 });
  }
}
