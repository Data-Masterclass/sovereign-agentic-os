/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWorkflow } from './schema.ts';
import type { Gap } from './gaps.ts';
import { buildWorkflowReport, workflowPdfFilename } from './workflow-pdf.ts';
import { renderSwimlaneSvg } from './swimlane-svg.ts';

const WF = `---
id: bank-submission
title: Bank Submission
domain: sales
visibility: Shared
status: live
version: "2"
rules:
  - {id: wr1, text: "Quality over speed", hard: false, scope: workflow}
actors:
  - {name: Loan Officer, category: Human, description: Owns the file}
  - {name: Applicant, category: Customer, description: The end customer}
---

\`\`\`step
id: prepare
title: Prepare Documents
actor: Human
actor_name: Loan Officer
inputs: [Application]
outputs: [Package]
rules:
  - {id: sr1, text: "All fields required", hard: true}
\`\`\`

> tacit: Check section 4 — the date field is frequently missed.

\`\`\`step
id: intake
title: Submit Application
actor: Customer
actor_name: Applicant
links:
  - {type: data, ref: "sales.gold.missing_ds", label: Missing Dataset}
\`\`\`
`;

test('buildWorkflowReport maps identity, actors, steps in order', () => {
  const wf = parseWorkflow(WF);
  const report = buildWorkflowReport(wf, []);

  assert.equal(report.title, 'Bank Submission');
  // Subtitle carries domain · status · visibility.
  assert.match(report.subtitle, /Sales/);
  assert.match(report.subtitle, /Live/);
  assert.match(report.subtitle, /Domain/);

  // Actor registry preserved, external flagged, description carried.
  const applicant = report.actors.find((a) => a.name === 'Applicant');
  assert.ok(applicant, 'Applicant actor present');
  assert.equal(applicant!.external, true);
  assert.equal(applicant!.description, 'The end customer');
  const officer = report.actors.find((a) => a.name === 'Loan Officer');
  assert.equal(officer!.external, false);

  // Steps in order with actor label, inputs/outputs, hard rule + tacit.
  assert.equal(report.steps.length, 2);
  assert.equal(report.steps[0].seq, 1);
  assert.equal(report.steps[0].actor, 'Human: Loan Officer');
  assert.deepEqual(report.steps[0].inputs, ['Application']);
  assert.equal(report.steps[0].rules[0].hard, true);
  assert.match(report.steps[0].tacit, /section 4/);
  assert.equal(report.steps[1].category, 'Customer');

  // Workflow-scoped rules surfaced.
  assert.equal(report.workflowRules.length, 1);
  assert.match(report.workflowRules[0].text, /Quality over speed/);
});

test('buildWorkflowReport folds gaps into a handover summary', () => {
  const wf = parseWorkflow(WF);
  const gap: Gap = {
    stepId: 'intake',
    stepTitle: 'Submit Application',
    link: { type: 'data', ref: 'sales.gold.missing_ds', label: 'Missing Dataset' },
    buildTab: 'data',
    buildHref: '/data',
  };
  const report = buildWorkflowReport(wf, [gap]);
  assert.equal(report.gaps.length, 1);
  assert.equal(report.gaps[0].step, 'Submit Application');
  assert.equal(report.gaps[0].kind, 'data');
  assert.equal(report.gaps[0].ref, 'Missing Dataset');
});

test('workflowPdfFilename is filesystem-safe and stable', () => {
  const name = workflowPdfFilename('Bank Submission!!', Date.parse('2026-06-27T10:30:00Z'));
  assert.match(name, /^workflow-bank-submission-2026-06-27T10-30\.pdf$/);
});

test('renderSwimlaneSvg emits a standalone SVG with dashed external lanes', () => {
  const wf = parseWorkflow(WF);
  const { svg, width, height } = renderSwimlaneSvg(wf);
  assert.ok(width > 0 && height > 0);
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  // The Customer lane (external) must be dashed.
  assert.match(svg, /stroke-dasharray="5 4"/);
  assert.match(svg, /EXTERNAL/);
  // Both step titles rendered.
  assert.match(svg, /Prepare Documents/);
  assert.match(svg, /Submit Application/);
});

test('renderSwimlaneSvg escapes XML in titles and passes gap markers', () => {
  const wf = parseWorkflow(WF.replace('Prepare Documents', 'A & B <x>'));
  const { svg } = renderSwimlaneSvg(wf, { gapFor: (s) => (s.id === 'prepare' ? 2 : 0) });
  assert.match(svg, /A &amp; B &lt;x&gt;/);
  assert.match(svg, /⚠ 2/);
});
