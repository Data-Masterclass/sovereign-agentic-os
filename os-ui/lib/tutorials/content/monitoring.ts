/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const monitoring: TutorialDef = {
  key: 'monitoring',
  route: '/monitoring',
  title: 'Monitoring',
  tagline: 'What needs a human first — runs, spend, and drift, scoped to you.',
  buttonLabel: 'Monitoring Tutorial',
  hook: {
    illustration: 'dashboard',
    title: 'The read plane',
    body: 'Monitoring shows what your agents, pipelines, and artifacts are doing — and puts the few things that need a human at the very top. It is read-only by design: nothing here mutates, sets policy, or caps spend. You watch here; you act in the tabs.',
  },
  steps: [
    {
      illustration: 'dashboard',
      title: 'Attention first',
      body: 'The reds and ambers lead; greens recede to a quiet all-clear line. No wall of charts to scan — if the top strip is empty, you are done looking.',
    },
    {
      illustration: 'metric',
      title: 'Sweep the five lenses',
      body: 'Runs, Pipelines, Cost, System, Artifacts — five cards, worst first inside each. One sweep covers everything you own: what ran, what moved data, what it cost, what serves it, and what it produced.',
    },
    {
      illustration: 'agent',
      title: 'Drill into a run trace',
      body: 'Click any run item and the trace drawer opens: every step the agent took, its inputs, outputs, and cost. When something looks wrong, the trace is how you find out what actually happened.',
    },
    {
      illustration: 'sandbox',
      title: 'Scoped to you',
      body: 'You see your own runs and artifacts; Builders see their whole domain — the same identity and row-level security as everywhere else in the OS. Nobody watches what they do not govern.',
      byRole: {
        builder: {
          body: 'Creators see their own runs; you see your whole domain — the same identity and row-level security as everywhere else. Drift, failures, and spend across the domain surface to you first.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.monitoring.sandbox,
      sandboxAnchor: ANCHORS.monitoring.sandbox,
      route: '/monitoring',
      title: 'Open the read plane',
      body: 'Everything on this tab is a read — no button here mutates anything. Explore as much as you like.',
    },
    {
      anchor: ANCHORS.monitoring.scope,
      sandboxAnchor: ANCHORS.monitoring.sandbox,
      route: '/monitoring',
      title: 'Check your scope',
      body: 'The scope pill says whose world you are seeing. Creators see their own; Builders see their domain. Same data, honest boundaries.',
    },
    {
      anchor: ANCHORS.monitoring.attention,
      sandboxAnchor: ANCHORS.monitoring.sandbox,
      route: '/monitoring',
      title: 'Start with what needs you',
      body: 'The attention strip holds only reds and ambers. Click a card to open its full run trace — every step, input, output, and cost. Empty strip, calm day.',
    },
    {
      anchor: ANCHORS.monitoring.lenses,
      sandboxAnchor: ANCHORS.monitoring.sandbox,
      route: '/monitoring',
      title: 'Sweep the five lenses',
      body: 'Runs, Pipelines, Cost, System, Artifacts — worst first inside each card. Anything drillable opens the same trace drawer. When something needs fixing, act in its tab; when it needs a decision, that is Governance.',
    },
  ],
  sandbox: {
    lane: 'Your scope - read-only by design',
    anchor: ANCHORS.monitoring.sandbox,
    note: 'Monitoring never writes: every card, lens, and trace drawer is a read under your own identity. There is nothing you can break here.',
  },
  outro: {
    title: 'You know where to look first',
    body: 'Attention strip, five lenses, trace drawer — in that order, scoped to you. Next, run an agent and watch its trace appear here, or open Governance where the caps and policies behind these numbers are set.',
    next: ['agents', 'governance'],
    doc: 'monitoring-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Watch',
      hook: 'See what ran for you, what it cost, and whether it is healthy.',
    },
    creator: {
      verb: 'Trace',
      hook: 'Follow your agents and pipelines end to end when something looks off.',
    },
    builder: {
      verb: 'Oversee',
      hook: 'Watch the domain — drift, failures, spend — and act where you govern.',
    },
  },
};

export default monitoring;
