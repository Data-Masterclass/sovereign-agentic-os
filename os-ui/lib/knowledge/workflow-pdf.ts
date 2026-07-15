/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { EXTERNAL_ACTORS, type Workflow, type Actor } from './schema.ts';
import type { Gap } from './gaps.ts';

/**
 * Pure `Workflow → structured WorkflowReport` — the framework-free data the
 * Export-PDF painter walks section by section (mirror of the Agents run report in
 * `lib/agents/build/run-diagnostics.ts`). Kept DOM-free + jsPDF-free so it is
 * trivially unit-testable: the component maps the loaded workflow into this shape,
 * rasterises the swimlane for page 1, then paints these sections below.
 *
 * The report leads with the beautiful visual flow (the swimlane, embedded as an
 * image by the caller), then the actor registry, the steps in order, and a
 * handover/gaps summary when present.
 */

/** One actor row for the registry section. */
export type ReportActor = {
  name: string;
  category: string;
  description: string;
  external: boolean;
};

/** One step, flattened to printable strings (order preserved). */
export type ReportStep = {
  seq: number;
  title: string;
  actor: string; // "Human: Loan Officer" or just "Human"
  category: string;
  inputs: string[];
  outputs: string[];
  rules: { text: string; hard: boolean }[];
  tacit: string;
};

/** A structured, framework-free report the PDF painter renders section by section. */
export type WorkflowReport = {
  title: string;
  /** Identity line under the title on page 1 (domain · status · visibility). */
  subtitle: string;
  meta: { domain: string; status: string; visibility: string; version: string };
  actors: ReportActor[];
  steps: ReportStep[];
  workflowRules: { text: string; hard: boolean }[];
  /** Handover / gaps summary — one line per unresolved link, empty when none. */
  gaps: { step: string; kind: string; ref: string }[];
};

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** Map a loaded {@link Workflow} (+ its computed gaps) into a clean WorkflowReport. */
export function buildWorkflowReport(workflow: Workflow, gaps: Gap[] = []): WorkflowReport {
  const status = workflow.status === 'live' ? 'Live' : 'Draft';
  const visLabel =
    workflow.visibility === 'Shared'
      ? 'Shared in Domain'
      : workflow.visibility === 'Marketplace'
        ? 'Marketplace'
        : 'Personal';
  const subtitleParts = [workflow.domain ? cap(workflow.domain) : null, status, visLabel].filter(Boolean) as string[];

  const actors: ReportActor[] = workflow.actors.map((a: Actor) => ({
    name: a.name,
    category: a.category,
    description: (a.description ?? '').trim(),
    external: EXTERNAL_ACTORS.includes(a.category),
  }));

  const steps: ReportStep[] = workflow.steps.map((s, i) => ({
    seq: i + 1,
    title: s.title,
    actor: s.actor_name ? `${s.actor}: ${s.actor_name}` : s.actor,
    category: s.actor,
    inputs: [...s.inputs],
    outputs: [...s.outputs],
    rules: s.rules.map((r) => ({ text: r.text, hard: r.hard })),
    tacit: s.tacit.trim(),
  }));

  const workflowRules = workflow.rules
    .filter((r) => r.scope === 'workflow')
    .map((r) => ({ text: r.text, hard: r.hard }));

  const gapRows = gaps.map((g) => ({
    step: g.stepTitle,
    kind: g.link.type,
    ref: g.link.label || g.link.ref,
  }));

  return {
    title: workflow.title || 'Untitled workflow',
    subtitle: subtitleParts.join('  ·  '),
    meta: { domain: workflow.domain, status, visibility: visLabel, version: workflow.version },
    actors,
    steps,
    workflowRules,
    gaps: gapRows,
  };
}

/** Filename like `workflow-<slug>-<shortts>.pdf` — filesystem-safe, no spaces. */
export function workflowPdfFilename(title: string, at: number = Date.now()): string {
  const slug =
    (title || 'workflow').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'workflow';
  const ts = new Date(at).toISOString().replace(/[:.]/g, '-').slice(0, 16); // YYYY-MM-DDTHH-MM
  return `workflow-${slug}-${ts}.pdf`;
}
