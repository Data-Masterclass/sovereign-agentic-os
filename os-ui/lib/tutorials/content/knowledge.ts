/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const knowledge: TutorialDef = {
  key: 'knowledge',
  route: '/knowledge',
  title: 'Knowledge',
  tagline: 'Capture how you and your domain work — so every agent starts from the same playbook.',
  buttonLabel: 'Knowledge Tutorial',

  hook: {
    illustration: 'knowledge',
    title: 'The context your agents read',
    body: 'Two surfaces, one playbook. Knowledge holds free-form notes — how you work, key contacts, domain context. Business Processes (its own tab) holds your business processes with steps and decision rules. Agents read both as context automatically — no copy-paste required.',
    byRole: {
      builder: {
        body: 'Two surfaces, one playbook: Knowledge notes and Business Processes. You approve what gets promoted to the Domain tier — so every agent in the domain is aligned on the same, reviewed context.',
      },
    },
  },

  steps: [
    {
      illustration: 'knowledge',
      title: 'Write it down as a note',
      body: 'On Knowledge, "＋ New" opens the "New knowledge" chooser — pick "General knowledge" to write a free-form markdown note (your role, preferences, working style, key context) straight in Edit, or "Workflow →" to map a business process. My knowledge is personal; Domain holds notes promoted by domain members; Company holds certified knowledge from across the org.',
    },
    {
      illustration: 'build',
      title: 'Map a business process',
      body: 'On the Business Processes tab, "+ New business process" names a process — Bank Submission, Customer Onboarding — and lays out its steps and decision rules. The Domain Operating Manual (overview, glossary, goals) lives at the top of Business Processes.',
    },
    {
      illustration: 'publish',
      title: 'Promote what the domain should share',
      body: 'Both notes and business processes climb the same ladder: "Promote to Domain" (or "Request promotion") sends it for approval in Policies & Approvals; an Admin can "Certify to Company". "Unshare" and "Revoke from Company" walk it back.',
      byRole: {
        builder: {
          body: 'Both notes and business processes climb the same ladder. Requests land in Policies & Approvals for your yes; an Admin certifies to Company. What you approve becomes live context for every domain agent.',
        },
      },
    },
    {
      illustration: 'agent',
      title: 'Agents read it automatically',
      body: 'Published knowledge becomes agent context: an agent granted your knowledge pulls the relevant notes and business processes when it works. Archived notes are hidden from your agents — the archive is how you retire stale context without deleting it.',
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.knowledge.sandbox,
      sandboxAnchor: ANCHORS.knowledge.sandbox,
      title: 'Open My knowledge',
      body: 'The scope buttons — All, My, Domain, Company — say whose notes you see. My knowledge is your private lane: notes here are yours alone until a promotion is approved.',
      route: '/knowledge',
    },
    {
      anchor: ANCHORS.knowledge.add,
      sandboxAnchor: ANCHORS.knowledge.sandbox,
      title: 'Add a note',
      body: '"＋ New" → "General knowledge" opens a note in Edit — give it a title ("How I like reports", "Key contacts"), write free-form markdown, and Save. Short, honest notes beat long perfect ones.',
      route: '/knowledge',
    },
    {
      anchor: ANCHORS.knowledge.organize,
      sandboxAnchor: ANCHORS.knowledge.sandbox,
      title: 'Map a business process',
      body: 'Switch to the Business Processes tab and "+ New business process": name the process, lay out its steps and decision rules. Business processes follow the same My / Domain / Company scopes as everything else.',
      route: '/workflows',
    },
    {
      anchor: ANCHORS.knowledge.publish,
      title: 'Promote to Domain',
      body: '"Promote to Domain" — or "Request promotion" — files the request; it is approved in Policies & Approvals. Once approved, the note or business process becomes live context for every domain agent.',
      governedWrite: true,
      route: '/knowledge',
    },
  ],

  sandbox: {
    lane: 'My knowledge — personal notes',
    anchor: ANCHORS.knowledge.sandbox,
    note: 'Notes stay private until a promotion is approved — nothing you write here affects live domain knowledge or agent context.',
  },

  outro: {
    title: 'Your playbook is live',
    body: 'You captured how you work and mapped a process — and you know the ladder that shares it. Agents will use it as context automatically. Next: build agents that act on it, or add the data products it references.',
    next: ['agents', 'data'],
    doc: 'knowledge-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Explore',
      hook: 'Read the domain\'s notes and business processes and see how the pieces connect.',
    },
    creator: {
      verb: 'Create',
      hook: 'Write notes and map business processes that give your agents real context.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Approve the notes and business processes that become your domain\'s shared playbook.',
    },
  },
};

export default knowledge;
