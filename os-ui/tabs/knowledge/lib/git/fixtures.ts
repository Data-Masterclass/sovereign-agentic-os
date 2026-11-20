/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 test fixtures — knowledge records as the store holds them
 * USER STORY: As a test author I want one realistic workflow (soft and hard rules, a step, tacit
 *             notes) and one domain manual, shared by the bundle, commit and eject tests.
 * ARCHITECTURE: Plain data; imported by tests only.
 */
import type { WorkflowRecord } from '@tabs/knowledge/lib/store';
import type { DomainKnowledge } from '@tabs/knowledge/lib/schema';

export const WF_MD = `---
id: wf_bank
title: Bank Submission
domain: sales
visibility: Shared
status: live
version: "3"
rules:
  - {id: wr1, text: "Quality over convenience", hard: false, scope: workflow}
  - {id: wr2, text: "Never submit without sign-off", hard: true, scope: workflow}
actors: []
---

Submit the monthly pack to the bank.

\`\`\`step
id: verify
title: Verify
actor: Agent
rules:
  - {id: sr1, text: "Error rate < 0.1%", hard: true}
\`\`\`
`;

export function workflowRecord(over: Partial<WorkflowRecord> = {}): WorkflowRecord {
  return {
    id: 'wf_bank',
    domain: 'sales',
    owner: 'alex@example.com',
    md: WF_MD,
    tacit: 'Call Petra before the 5th; the bank portal times out after 10 minutes.',
    title: 'Bank Submission',
    visibility: 'Shared',
    status: 'live',
    updatedAt: '2026-11-20T10:00:00.000Z',
    publishedAt: '2026-11-20T10:00:00.000Z',
    publishedBy: 'alex@example.com',
    certifiedAt: null,
    certifiedBy: null,
    folder: '/',
    ...over,
  };
}

export function manual(over: Partial<DomainKnowledge> = {}): DomainKnowledge {
  return {
    domain: 'sales',
    sections: [
      { id: 'general', title: 'General', content: 'The sales domain sells to banks.' },
      { id: 'glossary', title: 'Glossary', content: '' },
    ],
    updatedAt: '2026-11-20T10:00:00.000Z',
    ...over,
  };
}
