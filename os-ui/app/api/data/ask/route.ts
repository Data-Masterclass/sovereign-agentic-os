/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { roleModel, standardFirstEscalationEnabled } from '@/lib/models/roles';
import { requirePrincipal, errorResponse } from '@/lib/data/server';
import { listAskable } from '@/lib/data/store';
import { readPrincipalFor } from '@/lib/data/store-fqn';
import { queryRun, trace } from '@/lib/infra/governed';
import { liteLlmCaller } from '@/lib/assistant/runtime';
import { runAsk, type AskMessage } from '@/lib/data/ask';
import { appSlugFromRequest, grantedIdSet } from '@/lib/software/app-origin';

export const dynamic = 'force-dynamic';

/**
 * Talk-to-your-data v2 (NL→SQL). The browser POSTs { question }; we:
 *   1. scope the LLM context to the registry docs of datasets the SESSION user
 *      canView (`listAskable`) — never another user's schema/docs; for an APP origin
 *      that set is further narrowed to the app's granted datasets (least privilege);
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

    // LEAST-PRIVILEGE for app origins: the NL→SQL surface is FREE-FORM over EVERY
    // dataset the session user can see (listAskable). For an APP origin we RESTRICT that
    // set to (user access ∩ the app's `grants.data` ids), so the model can only ground on
    // — and the generated SQL can only target — datasets the app was granted. The filtered
    // list is the SAME one used for both the prompt context AND execution (the only door is
    // the FQNs the prompt shows the model; runAsk validates read-only-SELECT and executes
    // via governed queryRun, so trimming the visible datasets IS the SQL-target cap).
    //   • zero data grants  → honest 403 (nothing to ask over);
    //   • unknown slug       → grantedIdSet returns ∅ (fail closed) → the same 403;
    //   • non-app request    → appSlugFromRequest is null, no I/O, list is unchanged.
    const appSlug = appSlugFromRequest(req);
    let grantedData: Set<string> | null = null;
    if (appSlug) {
      grantedData = await grantedIdSet(appSlug, 'data');
      if (grantedData.size === 0) {
        return NextResponse.json(
          {
            error:
              `This app (${appSlug}) has no dataset grants — grant one in the OS Software ` +
              `tab → ${appSlug} → Context.`,
          },
          { status: 403 },
        );
      }
    }

    let question = '';
    try {
      const body = await req.json();
      question = (body?.question ?? '').toString().trim();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    if (!question) return NextResponse.json({ error: 'Missing question' }, { status: 400 });

    // The ONLY schema context the model sees: canView-scoped registry docs — further
    // narrowed to the app's granted datasets for an app origin (grantedData set above).
    const datasets = grantedData
      ? listAskable(user).filter((d) => grantedData!.has(d.id))
      : listAskable(user);

    const call = liteLlmCaller();
    const result = await runAsk({
      question,
      datasets,
      llm: async (messages: AskMessage[], model: string) =>
        (await call({ model, messages, temperature: 0 })).content,
      // COST ROUTING (standard-first): the generated SQL is strictly validated
      // (validateReadOnlySelect) before it ever runs, so generation attempts the
      // STANDARD tier first and escalates to reasoning ONLY when that guard rejects the
      // cheap SQL. Admin toggle OFF ⇒ generate on reasoning directly (no escalate tier).
      // The grounded summary stays on standard (light work) regardless.
      models: standardFirstEscalationEnabled()
        ? { generate: roleModel('standard'), generateEscalate: roleModel('reasoning'), summarize: roleModel('standard') }
        : { generate: roleModel('reasoning'), summarize: roleModel('standard') },
      // Owner-aware principal, resolved per generated SQL: a read of the caller's OWN
      // `personal_<uid>` lane runs AS the owner (that schema is owner-only under OPA
      // `is_owned_personal`, so the domain principal is denied); a governed asset/product
      // read runs as the caller's domain. Derived SERVER-SIDE — never from the body.
      query: (sql) => queryRun(sql, readPrincipalFor(sql, user)),
    });

    // The principal the executed SQL actually ran as (owner for a personal-lane read,
    // else the domain) — recorded on the audit trace so Monitoring reflects the truth.
    const principal = readPrincipalFor(result.sql ?? '', user);

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
      // Honest failure states: no accessible dataset — or a dataset that simply isn't
      // materialized yet — is a calm 200 answer (not an error); invalid SQL (rejected,
      // never executed) 422; a Trino/OPA refusal 502.
      const status =
        result.kind === 'no_dataset' || result.kind === 'not_materialized'
          ? 200
          : result.kind === 'invalid_sql'
            ? 422
            : 502;
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
