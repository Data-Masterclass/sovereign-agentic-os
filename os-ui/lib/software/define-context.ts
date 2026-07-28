/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * The DEFINE-stage context block (pure, unit-tested). Everything the user captured in
 * Define — the chosen TEMPLATE, the app NAME/DESCRIPTION, and the stated PURPOSE — must
 * travel into every downstream LLM prompt that DRAFTS a spec (Design) or GENERATES code
 * (Build), so features are grounded in what the app actually is, not invented in a
 * vacuum.
 *
 * This produces one honest, nil-safe "Context from Define" markdown block from the app
 * record. Kept pure so BOTH the Design assistant route and the Build chat route embed
 * the SAME block, and so a test can assert the Define context is present in the payload.
 */

/** Friendly template names (mirror components/software/SoftwareBuilder's TEMPLATE_LABEL). */
const TEMPLATE_LABEL: Record<string, string> = {
  'sovereign-app': 'Sovereign Application (OS sign-in + Admin + multi-tenant)',
  website: 'Website (public site, no sign-in)',
  'api-service': 'APIs only (headless service, no UI)',
  empty: 'Empty App (blank canvas)',
  'vite-os': 'Vite OS app (legacy)',
  'nextjs-supabase': 'Next.js + Supabase (legacy)',
  service: 'Service (legacy)',
  script: 'Script (legacy)',
  dashboard: 'Dashboard (legacy)',
};

export function templateLabel(template: string | undefined): string {
  return TEMPLATE_LABEL[template ?? ''] ?? template ?? '(unspecified)';
}

/** The minimal app shape the Define context reads. */
export type DefineContextApp = {
  name?: string;
  description?: string;
  template?: string;
  purpose?: string;
};

/**
 * The "## Context from Define" markdown block. Always includes the template (the one
 * choice that is always set); name/description/purpose are shown only when present, so
 * a sparse Define degrades to just the template line — never empty noise, never invented
 * detail. The generator is told to ground its work in this context.
 */
export function defineContextBlock(app: DefineContextApp): string {
  const lines = ['## Context from Define', `Template: ${templateLabel(app.template)}`];
  const name = (app.name ?? '').trim();
  const description = (app.description ?? '').trim();
  const purpose = (app.purpose ?? '').trim();
  if (name) lines.push(`App name: ${name}`);
  if (description) lines.push(`Description: ${description}`);
  if (purpose) lines.push(`Purpose: ${purpose}`);
  lines.push('Ground every feature spec and code change in this Define context — it is what the app IS.');
  return lines.join('\n');
}

/** Render a story's Design spec (features/NFRs/rules) as prompt lines. Nil-safe. */
export function specPromptLines(spec?: { features?: string[]; nfrs?: string[]; rules?: string[] }): string[] {
  if (!spec) return [];
  const out: string[] = [];
  if (spec.features?.length) out.push(`Features to build: ${spec.features.join('; ')}`);
  if (spec.nfrs?.length) out.push(`Non-functional requirements: ${spec.nfrs.join('; ')}`);
  if (spec.rules?.length) out.push(`Rules: ${spec.rules.join('; ')}`);
  return out;
}

/**
 * A short one-line "Context from Define" note for the UI detail panel (so the user sees
 * what the generator works from). Nil-safe. Returns '' when there is nothing beyond the
 * template to show — the caller can still show the template separately.
 */
export function defineContextNote(app: DefineContextApp): string {
  const parts = [templateLabel(app.template)];
  const purpose = (app.purpose ?? '').trim();
  if (purpose) parts.push(purpose);
  return parts.join(' · ');
}
