/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const dashboards: TutorialDef = {
  key: 'dashboards',
  route: '/dashboards',
  title: 'Dashboards',
  tagline: 'Compose native dashboards on governed metrics — every viewer sees their own rows.',
  buttonLabel: 'Dashboards Tutorial',

  hook: {
    illustration: 'dashboard',
    title: 'From governed metrics to a native dashboard',
    body: 'Five stages — Define · Design · Build · View · Govern. Bind one governed Cube view, design panels with a live preview, save, and view it rendered natively — every panel row-level-security scoped to whoever is looking. No BI tool in the loop, and the numbers can never disagree with your agents.',
    byRole: {
      builder: {
        body: 'Five stages — Define · Design · Build · View · Govern. Bind a governed view, design panels, save, view under per-viewer row-level security — then promote, certify, and export governed connections to the BI tools your domain already uses.',
      },
    },
  },

  steps: [
    {
      illustration: 'metric',
      title: 'Define — name it, bind one view',
      body: 'Metrics are defined in the Metrics tab — Dashboards only consume them. Give the dashboard a name, then click a governed metric chip to bind its Cube view: a dashboard binds to ONE governed view, and every panel stays on it. No metrics yet? Define one in Metrics first.',
    },
    {
      illustration: 'dashboard',
      title: 'Design — panels with a live preview',
      body: 'In the panel designer, multi-select governed metrics and pick a viz — big_number, line, area, bar, pie, or table. Charts "group by…" a dimension or trend "over time…" at a day-to-year grain, straight from the view\'s governed cube-meta. The Live preview resolves the exact query the grid will run — under your own row-level security — before you "＋ Add panel".',
    },
    {
      illustration: 'build',
      title: 'Build — save the dashboard',
      body: '"Save dashboard" persists the spec — that is all Build does. Panels render natively at View time (Apache ECharts on the governed Cube layer), so there is no BI-tool import step and nothing to sync. "Re-save" after any change, then "View it →".',
    },
    {
      illustration: 'governance',
      title: 'View — as each viewer, live',
      body: 'Every panel queries the governed Cube layer AS THE VIEWER: the resolved row-level-security clause is spelled out (e.g. "region = DE"), and a live / offline-mock badge says honestly whether Cube answered. Switch "View as" and every panel re-queries as that viewer — two people open the same dashboard and see different rows.',
    },
    {
      illustration: 'publish',
      title: 'Govern — share it, connect your tools',
      body: 'A dashboard is governed like any artifact: "Promote to Domain" files a request an approver confirms, and "Certify to Company" takes it company-wide. Schedule reports on a cadence, and connect your own BI — a one-click Power BI .pbids, the Tableau PostgreSQL fields, or "Open in Superset →" in its own tab when configured.',
      byRole: {
        creator: {
          body: 'A dashboard is governed like any artifact: "Propose to Domain" files a request an approver confirms in Governance. Schedule reports on a cadence, and connect your own BI — a one-click Power BI .pbids, the Tableau PostgreSQL fields, or "Open in Superset →" when configured.',
        },
        builder: {
          body: 'You approve promotions for your domain ("Promote to Domain"; an Admin can "Certify to Company"). Exported BI connections authenticate as the domain\'s read-only bi_<domain> principal — domain-scoped RLS, honestly labelled; per-viewer RLS stays native.',
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.dashboards.sandbox,
      sandboxAnchor: ANCHORS.dashboards.sandbox,
      route: '/dashboards',
      title: 'Open your dashboards',
      body: 'The list shows All · My · Domain · Company Dashboards — the same scopes as everywhere else. My Dashboards is your private lane; "＋ New dashboard" opens the five-stage flow on Define, and opening a tile lands you at View.',
    },
    {
      anchor: ANCHORS.dashboards.define,
      sandboxAnchor: ANCHORS.dashboards.sandbox,
      route: '/dashboards',
      title: 'Define — bind the view',
      body: 'Name the dashboard, then click a governed metric to bind it. That fixes the ONE Cube view every panel reads. If the palette is empty, define a metric in the Metrics tab first — Dashboards only consume governed metrics.',
    },
    {
      anchor: ANCHORS.dashboards.design,
      sandboxAnchor: ANCHORS.dashboards.sandbox,
      route: '/dashboards',
      title: 'Design a panel',
      body: 'Multi-select metrics, choose the viz, then "group by…" a dimension (bar, pie) or trend it "over time…" at a grain (line, area). Watch the Live preview — it runs the exact governed query the grid will — then "＋ Add panel" and repeat.',
    },
    {
      anchor: ANCHORS.dashboards.build,
      sandboxAnchor: ANCHORS.dashboards.sandbox,
      route: '/dashboards',
      title: 'Save it',
      body: '"Save dashboard" persists it — nothing renders here, no import runs. The panels resolve natively at View time on the governed Cube layer. Then "View it →".',
    },
    {
      anchor: ANCHORS.dashboards.view,
      sandboxAnchor: ANCHORS.dashboards.sandbox,
      route: '/dashboards',
      title: 'View — under your own rows',
      body: 'Every panel just queried as you: the Row-level security note shows the resolved clause, and the live / offline-mock badge tells you whether Cube answered. Switch "View as" — every panel re-queries as that viewer and the clause changes with it.',
    },
    {
      anchor: ANCHORS.dashboards.govern,
      route: '/dashboards',
      governedWrite: true,
      title: 'Govern — share and connect',
      body: 'Promote it up the ladder — "Promote to Domain" files a request an approver confirms; an Admin can "Certify to Company". Schedule a report ("Send now" to try it), and under Connected tools export a governed connection: Power BI .pbids, Tableau fields, or "Open in Superset →".',
    },
  ],

  sandbox: {
    lane: 'My Dashboards',
    anchor: ANCHORS.dashboards.sandbox,
    note: 'Dashboards stay Personal until promoted — design, save, and view privately. Every panel query still runs under your own row-level security, so practice never shows you rows you are not entitled to.',
  },

  outro: {
    title: 'Your dashboard renders natively — and honestly',
    body: 'You bound a governed view, designed panels with a live preview, saved, and viewed it under your own row-level security. Next: define more metrics to chart, or roll the dashboard into a Big Bet.',
    next: ['metrics', 'big-bets'],
    doc: 'dashboards-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Use',
      hook: 'Open a governed dashboard and see your own entitled rows — same metrics, your slice.',
    },
    creator: {
      verb: 'Create',
      hook: 'Design panels on governed metrics with a live preview — no SQL, no BI import.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Approve promotions, certify to Company, and export governed connections to Power BI or Tableau.',
    },
  },
};

export default dashboards;
