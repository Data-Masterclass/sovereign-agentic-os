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
      body: '"＋ New" first asks Simple or Complex on a two-card chooser. Simple is an aggregation over a dataset — Sum, Average, Count of unique or a Ratio. Complex is a formula over this dataset\'s existing metrics ([metric] refs, null-safe division, e.g. ([revenue] − [cost]) ÷ [revenue]). It works on any dataset with built Gold, including personal ones — no promotion needed. Describe it in words to the assistant and the form fills automatically. Tiles group into Simple Metrics and Complex Metrics.',
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
      title: 'Save, chart, promote, and alert',
      body: '"Save metric" returns you to a full-page View: its definition, how it is calculated, an explore, and an "On dashboards" section with "＋ Add to a dashboard". Then "Promote to Domain" so dashboards and agents reuse the exact definition. Alerts live right on the metric: set a threshold and it notifies you in-app via the sidebar bell — and optionally "Trigger an Agent" when it breaches.',
      byRole: {
        builder: {
          body: 'You approve promotions, so the domain reads one definition per number; an Admin certifies to Company. The metric View shows where it is charted ("Add to a dashboard"), and alerts live on the metric itself — thresholds that notify you in-app or "Trigger an Agent" on breach.',
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
      body: '"＋ New" asks Simple or Complex. Simple: pick the source dataset, name it, choose the aggregation — Sum, Count of unique or a Ratio. Complex: a formula over this dataset\'s existing metrics (works on personal datasets with built Gold, no promotion). Or describe it in words and let the assistant fill the form. Then refine: filter, time window, format, and the dimensions to slice by.',
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
      title: 'Save, chart, promote, alert',
      body: '"Save metric" opens its View — add it straight to a dashboard with "＋ Add to a dashboard". Then "Promote to Domain" — approved in Policies & Approvals — so every dashboard and agent resolves this one definition. Finish by setting a metric alert: a threshold that notifies you in-app via the sidebar bell, or "Trigger an Agent" on breach.',
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
