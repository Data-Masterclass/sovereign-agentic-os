/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const metrics: TutorialDef = {
  key: 'metrics',
  route: '/metrics',
  title: 'Metrics',
  tagline: 'One definition of every number — defined once, read everywhere.',
  buttonLabel: 'Metrics Tutorial',
  hook: {
    illustration: 'metric',
    title: 'Define a KPI everyone agrees on',
    body: 'Every business metric, defined once, on one screen. Each card carries its single canonical definition — the one the explorer, dashboards, and agents all resolve. Define it, preview the live number, promote it, and set an alert — without leaving the tab.',
  },
  steps: [
    {
      illustration: 'metric',
      title: 'Define it on governed data',
      body: '"＋ Define metric" opens the editor: pick a governed Gold dataset, name the metric, and choose what to measure — Sum, Average, Count of unique, even a Ratio. Describe it in words to the assistant and the form fills automatically, ready for review.',
    },
    {
      illustration: 'build',
      title: 'Refine the shape',
      body: 'Add an optional filter, a time window (running total or trailing window), the display format, and the dimensions to slice by. This shape is the definition — everything downstream inherits it.',
    },
    {
      illustration: 'dashboard',
      title: 'Preview the live number',
      body: 'The preview runs the exact governed query your saved metric will resolve, under your own identity and row-level security. What you see is what every reader will see — no SQL, no surprises.',
    },
    {
      illustration: 'publish',
      title: 'Save, promote, and set an alert',
      body: '"Save metric", then "Promote to Domain" so dashboards and agents can reuse the exact definition. Alerts live right on the metric: set a threshold, choose Email, Slack, or in-app — and optionally trigger a governed agent when it breaches.',
      byRole: {
        builder: {
          body: 'You approve promotions, so the domain reads one definition per number; an Admin certifies to Company. Alerts live on the metric itself — thresholds that notify or trigger a governed agent on breach.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.metrics.sandbox,
      sandboxAnchor: ANCHORS.metrics.sandbox,
      route: '/metrics',
      title: 'Open your metrics',
      body: 'The scope buttons — All, My, Domain, Company — say whose metrics you see. My Metrics is your private lane; drafts here are yours alone.',
    },
    {
      anchor: ANCHORS.metrics.define,
      sandboxAnchor: ANCHORS.metrics.sandbox,
      route: '/metrics',
      title: 'Define a metric',
      body: '"＋ Define metric": pick the source dataset, name it, choose the aggregation — or describe it in words and let the assistant fill the form. Then refine: filter, time window, format, and the dimensions to slice by.',
    },
    {
      anchor: ANCHORS.metrics.preview,
      sandboxAnchor: ANCHORS.metrics.sandbox,
      route: '/metrics',
      title: 'Preview the live number',
      body: '"Preview →" runs the exact governed query your saved metric will resolve, under your own identity. Nothing is saved yet — re-run until the number is right.',
    },
    {
      anchor: ANCHORS.metrics.publish,
      route: '/metrics',
      governedWrite: true,
      title: 'Save, promote, and alert',
      body: '"Save metric", then "Promote to Domain" — approved in Policies & Approvals — so every dashboard and agent resolves this one definition. Finish by setting a metric alert: a threshold that notifies you, or triggers a governed agent on breach.',
    },
  ],
  sandbox: {
    lane: 'My Metrics — personal definitions',
    anchor: ANCHORS.metrics.sandbox,
    note: 'Draft and preview metrics freely under your own identity; nothing is promoted until an approval goes through.',
  },
  outro: {
    title: 'Your KPI is live',
    body: 'One trusted definition now powers your charts, your agents, and your alerts alike. Next, chart it on a dashboard, or model more data to measure.',
    next: ['dashboards', 'data'],
    doc: 'metrics-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Use',
      hook: 'Explore governed KPIs and slice them with no SQL.',
    },
    creator: {
      verb: 'Define',
      hook: 'Define a metric on governed data, preview the live number, and set an alert.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Approve metric promotions so the domain reads one definition per number.',
    },
  },
};

export default metrics;
