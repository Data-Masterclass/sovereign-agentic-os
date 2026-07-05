/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const governance: TutorialDef = {
  key: 'governance',
  route: '/governance',
  title: 'Governance',
  tagline: 'One inbox where risky actions wait for a deliberate yes.',
  buttonLabel: 'Governance Tutorial',
  hook: {
    illustration: 'governance',
    title: 'Trust, made routine',
    body: 'Anything that crosses a trust boundary — sharing a file, an agent spending money, importing from another domain — queues here first and waits for a person. Creators file requests, Builders approve for their domain, Admins certify for the company. That two-step model is the whole system.',
    byRole: {
      builder: {
        body: 'Anything that crosses a trust boundary queues here and waits for you. Each request arrives with a preview — what, who, why, impact, cost — so a good decision takes seconds, and every decision lands on the audit trail.',
      },
    },
  },
  steps: [
    {
      illustration: 'governance',
      title: 'What queues here, and why',
      body: 'File promotions, marketplace imports, agent tool calls, deployments, spend over a limit — anything with consequences beyond its owner. Queuing is not bureaucracy; it is how newcomers get to act boldly without breaking anything.',
    },
    {
      illustration: 'document',
      title: 'Decide with a preview',
      body: 'Every request shows what it will do, who asked, why, the impact, a scan, and the estimated cost — before anything runs. A Builder approves or denies for their domain; requests above that need an Admin.',
      byRole: {
        creator: {
          body: 'Every request you file shows the approver what it will do, who asked, why, the impact, and the cost. Write a clear why and most requests sail through — the preview is your case.',
        },
      },
    },
    {
      illustration: 'build',
      title: 'Approve & remember',
      body: 'Saying yes to the same shaped request every day teaches nothing. Approve & remember turns one decision into a standing policy: future matching requests pass automatically, and the policy stays visible and revocable under Policies.',
    },
    {
      illustration: 'metric',
      title: 'Audit and cost, always on',
      body: 'Every decision — human or standing policy — lands on the audit trail: what, who, when. The cost view shows spend against limits, so budget surprises surface here, not on an invoice.',
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.governance.sandbox,
      sandboxAnchor: ANCHORS.governance.sandbox,
      route: '/governance',
      title: 'Open the inbox',
      body: 'Pending requests wait at the top, each with its preview. Reading the queue is always safe — nothing happens until someone clicks a decision.',
    },
    {
      anchor: ANCHORS.governance.approve,
      route: '/governance',
      governedWrite: true,
      roles: ['builder'],
      title: 'Approve or deny',
      body: 'Read the what, who, why, and impact — then decide. Approve applies the action live; Deny stops it and tells the requester. Either way it is on the record.',
    },
    {
      anchor: ANCHORS.governance.remember,
      route: '/governance',
      governedWrite: true,
      roles: ['builder'],
      title: 'Approve & remember',
      body: 'For a request you would approve every time, create the standing policy instead. Same-shaped requests now pass automatically — and the policy is listed, visible, and revocable.',
    },
    {
      anchor: ANCHORS.governance.audit,
      sandboxAnchor: ANCHORS.governance.sandbox,
      route: '/governance',
      title: 'Walk the audit trail',
      body: 'Every decision, by whom, when — including the automatic ones. If a creator asks where their request went, the answer is here.',
    },
    {
      anchor: ANCHORS.governance.cost,
      sandboxAnchor: ANCHORS.governance.sandbox,
      route: '/governance',
      title: 'Check spend and limits',
      body: 'Cost & limits shows what agents and pipelines are spending against their caps. Governance sets the limits; Monitoring watches the live burn.',
    },
  ],
  sandbox: {
    lane: 'The inbox - read-only review',
    anchor: ANCHORS.governance.sandbox,
    note: 'Read requests, previews, the audit trail, and cost freely; no decision is made until you click Approve or Deny for real.',
  },
  outro: {
    title: 'You know how trust works here',
    body: 'Creators file, Builders approve, Admins certify — with previews before and an audit trail after. Next, run an agent and watch its actions queue here, or import from the Marketplace and follow your own request through.',
    next: ['agents', 'marketplace'],
    doc: 'governance-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Follow',
      hook: 'See where requests go and who says yes.',
    },
    creator: {
      verb: 'Request',
      hook: 'File a clear request and track it to a decision.',
    },
    builder: {
      verb: 'Approve',
      hook: 'Decide with previews, set standing policies, keep the audit clean.',
    },
  },
};

export default governance;
