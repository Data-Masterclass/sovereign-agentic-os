/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/core/auth';
import { getSystem } from '@/lib/agents/store';
import { createFile } from '@/lib/files/store';
import { createPersonalKnowledge } from '@/lib/knowledge/personal-store';
import { createDataset } from '@/lib/data/store';
import { ingestAndRegisterBronze } from '@/lib/data/ingest';
import { canSaveFromResult, DATA_NON_TABULAR_NOTE } from '@/lib/agents/output-save';
import type { DeclaredOutput } from '@/lib/agents/system-schema';

export const dynamic = 'force-dynamic';

function fail(e: unknown) {
  const status = (e as { status?: number })?.status ?? 500;
  return NextResponse.json({ error: (e as Error).message }, { status });
}

/**
 * POST → SAVE the last run's final result into a DECLARED OUTPUT (Run/Evaluate action).
 *
 * The output was declared in Define (destination kind + name + folder + scope) and its
 * folder already carries a Write grant. Here we persist the run text into that
 * destination through the SAME governed create the tabs use — never a parallel store:
 *   • files     → `createFile` (foldered) — the run text as a .md/.csv/.txt file.
 *   • knowledge → `createPersonalKnowledge` (foldered My-knowledge lane) — text as body.
 *   • data      → `createDataset` + `ingestAndRegisterBronze` — ONLY when the result is
 *                 CSV/tabular; otherwise the agent's own write tools are the path and we
 *                 return a typed note (the client hides the button for this case too).
 *
 * Everything runs AS the current user (governed), so scope/DLS are enforced exactly as
 * on the tab. Body: `{ index, text }` — the output index into `system.outputs` + the
 * run text to persist (the client passes the output it just saw).
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => ({}))) as { index?: number; text?: string };

    const view = getSystem(id, user);
    const outputs: DeclaredOutput[] = view.system.outputs ?? [];
    const index = typeof body.index === 'number' ? body.index : -1;
    const output = outputs[index];
    if (!output) {
      return NextResponse.json({ error: 'No such declared output.' }, { status: 400 });
    }

    const text = (typeof body.text === 'string' && body.text.trim())
      ? body.text
      : (view.lastRun?.output ?? '');
    if (!text.trim()) {
      return NextResponse.json({ error: 'There is no run result to save yet — run the team first.' }, { status: 400 });
    }
    if (!canSaveFromResult(output, text)) {
      return NextResponse.json({ error: DATA_NON_TABULAR_NOTE }, { status: 400 });
    }

    const folder = output.folder.path;
    const name = output.name.trim();

    if (output.kind === 'files') {
      // A plain-text (Markdown/CSV) file in the declared folder — the Files-tab create path.
      const fileName = /\.[a-z0-9]{1,8}$/i.test(name) ? name : `${name}.md`;
      const asset = createFile(
        { id: user.id, domains: user.domains, role: user.role },
        { name: fileName, folder, text, sensitivity: 'internal' },
      );
      return NextResponse.json({ saved: { kind: 'files', id: asset.id, name: asset.name, folder } });
    }

    if (output.kind === 'knowledge') {
      // A My-knowledge note in the declared folder — the Knowledge-tab foldered create.
      const rec = createPersonalKnowledge(
        { id: user.id, domains: user.domains, role: user.role },
        { title: name, md: text, folder },
      );
      return NextResponse.json({ saved: { kind: 'knowledge', id: rec.id, name: rec.title, folder } });
    }

    // Data (tabular): create a private dataset, then ingest the CSV text as its Bronze —
    // the SAME governed pipeline the Data tab's "Upload a file" runs.
    const principal = { id: user.id, domains: user.domains, role: user.role };
    const ds = createDataset(principal, { name });
    const fileName = `${name.replace(/[^\w.-]+/g, '_') || 'result'}.csv`;
    const outcome = await ingestAndRegisterBronze(principal, ds.id, fileName, Buffer.from(text, 'utf8'));
    if (!outcome.ok) {
      return NextResponse.json({ error: `The dataset was created but the result could not be ingested (${outcome.report.mode ?? 'ingest failed'}).` }, { status: 502 });
    }
    return NextResponse.json({ saved: { kind: 'data', id: ds.id, name: ds.name, folder } });
  } catch (e) {
    return fail(e);
  }
}
