/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const knowledge: TutorialDef = {
  key: 'knowledge',
  route: '/knowledge',
  title: 'Knowledge',
  tagline: "Capture how your domain works — so every agent and team member starts from the same playbook.",
  buttonLabel: 'Knowledge Tutorial',

  hook: {
    illustration: 'knowledge',
    title: "Your domain's operating manual",
    body: 'Write down how your business actually works: the steps, the actors, the rules. Every agent in the domain reads this context automatically — no copy-paste required.',
    byRole: {
      builder: {
        body: 'Write the playbook, mark the hard rules as guardrails, and publish it — so every agent in the domain is aligned from day one.',
      },
    },
  },

  steps: [
    {
      illustration: 'knowledge',
      title: 'Write your domain overview',
      body: 'Add a short overview, a glossary, your goals, and key context. Type it, upload a markdown file, or let the knowledge agent draft it from your notes. This becomes the base context for every domain agent.',
    },
    {
      illustration: 'build',
      title: 'Map out a workflow',
      body: 'Create a tile for each business process. Lay out the steps visually — assign each one to a Human, Software, or Agent actor and link the data products, apps, and files it touches.',
    },
    {
      illustration: 'document',
      title: 'Add rules and tacit knowledge',
      body: "Write decision rules (mark the critical ones as enforced guardrails) and capture the practitioners' know-how. Upload a recording, paste a transcript, or type notes — the knowledge agent compresses it into clean markdown.",
    },
    {
      illustration: 'publish',
      title: 'Publish to the domain',
      body: 'A Builder reviews and publishes the workflow. It becomes live context: agents can pull the full workflow when they need it, and it is discoverable in the Marketplace.',
      byRole: {
        builder: {
          body: 'Review the draft, confirm the hard rules are correct, and publish. The workflow goes live as agent context and appears in the Marketplace.',
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.knowledge.sandbox,
      sandboxAnchor: ANCHORS.knowledge.sandbox,
      title: 'Open your personal knowledge lane',
      body: 'Drafts you write here are private until a Builder publishes them. Safe to experiment without affecting the live domain knowledge.',
      route: '/knowledge',
    },
    {
      anchor: ANCHORS.knowledge.add,
      sandboxAnchor: ANCHORS.knowledge.sandbox,
      title: 'Add a workflow',
      body: 'Name a business process and lay out its steps. Assign each step an actor — Human, Software, or Agent — and link the data products, apps, and files it touches.',
      route: '/knowledge',
    },
    {
      anchor: ANCHORS.knowledge.organize,
      sandboxAnchor: ANCHORS.knowledge.sandbox,
      title: 'Add rules and tacit knowledge',
      body: 'Write decision rules and mark the hard ones as enforced guardrails. Capture tacit know-how by pasting notes or recording an interview — the knowledge agent tidies everything into clean markdown.',
      route: '/knowledge',
    },
    {
      anchor: ANCHORS.knowledge.publish,
      title: 'Publish to the domain',
      body: 'Submit for Builder review. Once published, the workflow becomes live context for every domain agent and is listed in the Marketplace.',
      governedWrite: true,
      roles: ['builder'],
      route: '/knowledge',
    },
  ],

  sandbox: {
    lane: 'My knowledge — personal drafts',
    anchor: ANCHORS.knowledge.sandbox,
    note: 'Drafts stay private until a Builder publishes them — nothing you write here affects live domain knowledge or agent context.',
  },

  outro: {
    title: 'Your domain knowledge is live',
    body: 'You captured how your domain works. Agents will use it as context automatically. Next: build agents that act on it, or add the data products it references.',
    next: ['agents', 'data'],
    doc: 'knowledge-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Explore',
      hook: "Read the domain's operating manual and see how your workflows connect.",
    },
    creator: {
      verb: 'Create',
      hook: 'Draft workflows, decision rules, and tacit know-how for your domain.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review workflow drafts, mark enforced guardrails, and publish the live domain knowledge.',
    },
  },
};

export default knowledge;
