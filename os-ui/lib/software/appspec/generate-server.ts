/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import 'server-only';
import type { CurrentUser } from '@/lib/core/auth';
import { roleAtLeast } from '@/lib/core/session';
import { getAppByIdInternal, getAppForUser, withStatus, type App } from '@/lib/software/apps';
import { assistantComplete } from '@/lib/assistant/complete';
import { roleModel } from '@/lib/models/roles';
import { peekDatasetColumns, peekDatasetMeta } from '@/lib/data/store';
import {
  buildGeneratePrompt,
  parseGeneratedSpec,
  repairInstruction,
  type GenerateMaterial,
  type GenerateDataset,
  type GenerateGrant,
  type GenerateEpic,
} from './generate.ts';
import type { AppSpec, SpecIssue } from './schema.ts';

/**
 * The SHARED "Generate my app" server flow (0.6.136). The composer route
 * (`POST /api/apps/[id]/spec/generate`) and the `generate_app_spec` MCP tool both call this
 * ONE governed function, so there is a single source of truth for the gate, the material
 * gathering, the reasoning-model call, and the structural+semantic validation loop.
 *
 * It (a) view/authorization-gates the app (owner or an owning-domain builder+, the SAME gate
 * setAppSpec / the spec routes use), (b) gathers the GRANTED context (datasets with REAL
 * columns, metrics, agents) + the epics/stories, (c) calls the OS REASONING model via the
 * SAME `assistantComplete` path every assistant surface uses, (d) recovers the JSON, runs the
 * STRUCTURAL gate then the SEMANTIC gate (validateAppSpec against the real stores), and on a
 * validation failure does ONE repair turn seeded with the exact issues.
 *
 * It DOES NOT persist — it returns a validated (or failed) candidate. The caller persists it
 * through setAppSpec (the MCP author = publish door) or loads it as an editable draft (the UI).
 */
export type GenerateResult =
  | { ok: true; spec: AppSpec }
  | { ok: false; error: string; issues?: SpecIssue[] };

export async function generateAppSpecForApp(user: CurrentUser, appId: string): Promise<GenerateResult> {
  // VISIBILITY first: an app the caller cannot see is a not_found (no existence leak) — the SAME
  // gate get_app_spec / get_software apply. getAppByIdInternal (below) is unscoped, so the view
  // gate must run first.
  await getAppForUser(appId, user);
  const app = await getAppByIdInternal(appId);
  if (!app) throw withStatus(new Error('App not found'), 404);

  // The SAME edit gate setAppSpec / the spec route use: owner, or a builder+ in the app's domain.
  const ownerOrBuilder =
    app.owner === user.id || (roleAtLeast(user.role, 'builder') && user.domains.includes(app.domain));
  if (!ownerOrBuilder) throw withStatus(new Error('Only the creator can generate this app'), 403);

  const material = gatherMaterial(app);
  if (material.epics.length === 0) {
    return {
      ok: false,
      error: 'Design at least one epic with a user story first — the assistant builds your app from them.',
    };
  }

  const prompt = buildGeneratePrompt(material);
  const model = roleModel('reasoning');
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: prompt.system },
    { role: 'user', content: prompt.user },
  ];

  const { validateAppSpec } = await import('./validate.ts');

  let lastIssues: SpecIssue[] = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    let content: string;
    try {
      const res = await assistantComplete(messages, { model, user: { id: user.id, domains: user.domains } });
      content = res.content;
    } catch {
      return { ok: false, error: 'The build assistant is unavailable right now. Please try again in a moment.' };
    }

    const structural = parseGeneratedSpec(content);
    if (!structural.ok) {
      lastIssues = structural.issues;
    } else {
      const { issues } = await validateAppSpec(app, structural.spec, user);
      if (issues.length === 0) return { ok: true, spec: structural.spec };
      lastIssues = issues;
    }

    if (attempt === 0) {
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: repairInstruction(lastIssues) });
    }
  }

  return {
    ok: false,
    error: "The assistant couldn't produce a valid app from your design. Review the notes, then add or refine a tab yourself.",
    issues: lastIssues,
  };
}

/**
 * Fold the app's granted context + epics into the generator MATERIAL. Dataset columns come from
 * the SAME unscoped peek helper the validator uses (peekDatasetColumns) — one source of truth, so
 * a column the generator is offered is a column validateAppSpec will accept.
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

  return {
    appName: app.name,
    appDescription: app.description,
    grantedDatasets,
    grantedMetrics,
    grantedAgents,
    epics,
  };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
