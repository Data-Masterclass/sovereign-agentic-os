/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { NextResponse } from 'next/server';
import { withRoute } from '@/lib/core/route-server';
import { roleAtLeast } from '@/lib/core/session';
import { getAppByIdInternal, type App } from '@/lib/software/apps';
import { assistantComplete } from '@/lib/assistant/complete';
import { roleModel } from '@/lib/models/roles';
import { peekDatasetColumns, peekDatasetMeta } from '@/lib/data/store';
import { parseAppSpec, type AppSpec } from '@/lib/software/appspec/schema';
import { describeApp } from '@/lib/software/appspec/describe';
import {
  buildAssistPrompt,
  parseAssistedSpec,
  assistRepairInstruction,
  type GenerateMaterial,
  type GenerateDataset,
  type GenerateGrant,
  type GenerateEpic,
} from '@/lib/software/appspec/assist';

export const dynamic = 'force-dynamic';

/**
 * POST /api/apps/[id]/spec/assist — the AGENTIC Build-chat assistant (0.6.134).
 *
 * The Build-stage composer had a "Generate my app" (POST /spec/generate) but no CONVERSATIONAL
 * refine door. This route is the EDIT counterpart: given the current spec + a plain-language
 * instruction ("make the Orders tab a kanban by status", "add a KPI tab for total revenue"), it
 * returns the FULL updated, validated AppSpec — applied DIRECTLY (the composer loads it as its
 * working draft; the user Saves when happy) — plus a plain-language `reply` explaining what changed.
 *
 * It EXTENDS the generate.ts infra (same reasoning model via `assistantComplete`, same tolerant
 * parse, one repair turn, same closed cookbook grammar and granted-only material) with an EDIT
 * prompt. Governance is the SAME gate as /spec/generate + /spec: owner, or a builder+ in the app's
 * domain. Never persists — the composer owns Save. Always HTTP 200 for a business outcome so the
 * chat treats { ok:false, reply } as a normal "couldn't do that" turn, not a transport error.
 */
export const POST = withRoute<{ id: string }>(async ({ user, params, req }) => {
  const app = await getAppByIdInternal(params.id);
  if (!app) return NextResponse.json({ ok: false, error: 'App not found' }, { status: 404 });

  const ownerOrBuilder =
    app.owner === user.id || (roleAtLeast(user.role, 'builder') && user.domains.includes(app.domain));
  if (!ownerOrBuilder) {
    return NextResponse.json({ ok: false, error: 'Only the creator can refine this app' }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { instruction?: unknown; currentSpec?: unknown };
  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!instruction) {
    return NextResponse.json({ ok: false, reply: 'Tell me what to change — for example, "add a KPI tab for total revenue".' });
  }

  // The current spec: prefer the client's live working draft (the composer sends what's on screen);
  // fall back to the saved spec. Structurally gate it so we never feed the model garbage.
  const rawSpec = body.currentSpec ?? app.spec;
  const currentParse = parseAppSpec(rawSpec);
  if (!currentParse.ok) {
    return NextResponse.json({
      ok: false,
      reply: 'I could not read the current app — Save or Reset it first, then ask me again.',
    });
  }
  const currentSpec = currentParse.spec;

  const material = gatherMaterial(app);
  const prompt = buildAssistPrompt(material, currentSpec, instruction);
  const model = roleModel('reasoning');
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];

  const { validateAppSpec } = await import('@/lib/software/appspec/validate');

  let lastIssues: { path: string; reason: string; fix: string }[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let content: string;
    try {
      const res = await assistantComplete(messages, { model, user: { id: user.id, domains: user.domains } });
      content = res.content;
    } catch {
      return NextResponse.json({ ok: false, reply: 'The assistant is unavailable right now. Please try again in a moment.' });
    }

    const structural = parseAssistedSpec(content);
    if (!structural.ok) {
      lastIssues = structural.issues;
    } else {
      const { issues } = await validateAppSpec(app, structural.spec, user);
      if (issues.length === 0) {
        return NextResponse.json({ ok: true, spec: structural.spec, reply: changeReply(currentSpec, structural.spec, instruction) });
      }
      lastIssues = issues;
    }

    if (attempt === 0) {
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: assistRepairInstruction(lastIssues) });
    }
  }

  // Both attempts failed the gate — explain honestly and change NOTHING (the composer keeps its draft).
  return NextResponse.json({
    ok: false,
    reply:
      "I couldn't do that safely — it would need data or a layout that isn't available here, so I left your app unchanged. Try rephrasing, or edit the tab directly.",
    issues: lastIssues,
  });
}, { defaultStatus: 500 });

/**
 * A short, plain-language summary of what the edit changed — derived by DIFFING the old vs new
 * `describeApp` tab lists (pure, no model claims). Never invents behaviour: it reports added/removed/
 * changed tabs by label + what each now shows/does. When nothing structural changed it says so.
 */
function changeReply(before: AppSpec, after: AppSpec, instruction: string): string {
  const b = describeApp(before).tabs;
  const a = describeApp(after).tabs;
  const bByLabel = new Map(b.map((t) => [t.label, t]));
  const aByLabel = new Map(a.map((t) => [t.label, t]));

  const added = a.filter((t) => !bByLabel.has(t.label));
  const removed = b.filter((t) => !aByLabel.has(t.label));
  const changed = a.filter((t) => {
    const prev = bByLabel.get(t.label);
    return prev && prev.what !== t.what;
  });

  const lines: string[] = [];
  for (const t of added) lines.push(`Added the **${t.label}** tab — ${t.what}`);
  for (const t of removed) lines.push(`Removed the **${t.label}** tab.`);
  for (const t of changed) lines.push(`Updated **${t.label}** — ${t.what}`);

  if (lines.length === 0) {
    return `Done. I applied "${instruction}" — review the live preview and Save when you're happy.`;
  }
  return `${lines.join('\n')}\n\nReview the live preview and Save when you're happy.`;
}

/**
 * Fold the app's granted context + epics into the generator MATERIAL — the SAME shape /spec/generate
 * uses (dataset columns via the unscoped `peekDatasetColumns`, one source of truth with the
 * validator so an offered column is an accepted column).
 */
function gatherMaterial(app: App): GenerateMaterial {
  const grantedDatasets: GenerateDataset[] = (app.grants?.data ?? []).map((g): GenerateDataset => {
    const meta = safe(() => peekDatasetMeta(g.id));
    const columns = safe(() => peekDatasetColumns(g.id)) ?? [];
    return { id: g.id, name: meta?.name || g.id, columns };
  });
  const grantedMetrics: GenerateGrant[] = (app.grants?.metrics ?? []).map((g): GenerateGrant => ({ id: g.id, name: g.id }));
  const grantedAgents: GenerateGrant[] = (app.agents ?? []).map((a): GenerateGrant => ({ id: a.id, name: a.id }));

  const epics: GenerateEpic[] = (app.epics ?? []).map((e): GenerateEpic => ({
    id: e.id,
    title: e.title,
    stories: (e.stories ?? []).map((s) => ({
      id: s.id,
      title: s.title,
      features: s.spec?.features ?? [],
      nfrs: s.spec?.nfrs ?? [],
      rules: s.spec?.rules ?? [],
    })),
  }));

  return { appName: app.name, appDescription: app.description, grantedDatasets, grantedMetrics, grantedAgents, epics };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
