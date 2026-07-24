/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const data: TutorialDef = {
  key: 'data',
  route: '/data',
  title: 'Data',
  tagline: 'Turn a raw file into a trusted data product your whole domain can use.',
  buttonLabel: 'Data Products Tutorial',

  hook: {
    illustration: 'load',
    title: 'From raw file to trusted data product',
    body: 'Five stages — Ingest, Define, Harmonize, Validate, Publish. Land a file as Bronze, clean it into Silver, shape a Gold business table, prove its quality, and share it — so your team and your agents always work from the same certified numbers.',
    byRole: {
      builder: {
        body: 'Five stages — Ingest, Define, Harmonize, Validate, Publish. Land, clean, harmonize, prove quality, then promote and certify — so your domain always works from one trusted source of truth.',
      },
    },
  },

  steps: [
    {
      illustration: 'load',
      title: 'Ingest — land your Bronze',
      body: 'Create a dataset with "+ New dataset", then either "Upload a file" (CSV, Parquet, JSON…) or "Pull from a product" you already trust. Confirm the preview and your raw data lands as a versioned Bronze table.',
    },
    {
      illustration: 'clean',
      title: 'Define — document, then clean into Silver',
      body: 'The columns are real now. Describe the dataset and what each column means, then "Clean it up — Silver": build the Silver version, see "Silver built ✓" with an explore preview, and edit + "Rebuild Silver version" until it is right. Then "Continue to Harmonize →".',
    },
    {
      illustration: 'build',
      title: 'Harmonize — shape the Gold table',
      body: 'Pick the columns you want and name your measures. A join is optional — a single-table Gold is fine, and if your Silver is already business-ready you can "Pass through Gold…". Rebuild until the preview looks right, then "Continue to Validate →".',
    },
    {
      illustration: 'governance',
      title: 'Validate — prove the quality',
      body: 'Accept the suggested checks from the profile or add your own rules, then "Run checks" for a real pass/fail per rule. Auto-monitors watch freshness, row volume, and schema; the lineage chain shows where every number came from.',
    },
    {
      illustration: 'publish',
      title: 'Publish — share it and build on it',
      body: 'Sharing comes first: "Promote to Domain →" files a request an approver confirms in Governance; an Admin can "Certify to Company →". Then ask the data questions in plain language, and jump straight into the metrics, dashboards, and agent systems built on it.',
      byRole: {
        creator: {
          body: 'Sharing comes first: "Promote to Domain →" files a request an approver confirms in Governance. Then ask the data questions in plain language, and jump straight into the metrics, dashboards, and agent systems built on it.',
        },
        builder: {
          body: 'Sharing comes first: approve promotions for your domain, or "Certify to Company →" as Admin. Then ask the data questions in plain language, and see every metric, dashboard, and agent system built on this dataset.',
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.data.sandbox,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Open your datasets',
      body: 'Home shows All Data, My Data, Domain Data, and Company Data. My Data is your private space — practice here without touching anything shared. The sidebar "Domain:" picker narrows everything (even My items) to one domain; "All domains" restores the full view.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.load,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Ingest your Bronze',
      body: 'Start with "+ New dataset", then "Upload a file" or "Pull from a product". Check the raw preview and confirm — your data lands as a versioned Bronze table, ready to shape.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.document,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Document it',
      body: 'In Define, answer "What is this dataset?" and fill in the column meanings, then "Save documentation". Documented data is discoverable — and documentation is the gate for sharing later.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.clean,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Clean it up — Silver',
      body: 'Build the Silver version right here in Define. You stay on the step: "Silver built ✓" appears with an explore preview, and you can edit and "Rebuild Silver version" as often as you like. Happy? "Continue to Harmonize →".',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.harmonize,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Harmonize — Gold',
      body: 'Pick columns, name measures, and optionally join in other datasets you can see — a single-table Gold is fine, and "Pass through Gold…" carries a business-ready Silver forward unchanged. "Rebuild Gold version" until it is right, then "Continue to Validate →".',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.validate,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Validate the quality',
      body: 'Accept the suggested checks, add your own rules, and "Run checks" — a real pass/fail per rule against the built table. Auto-monitors (freshness, row volume, schema) stay on by default, and Lineage traces the chain.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.query,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Ask your data',
      body: 'In Publish, ask a question in plain language — "What was revenue last month?" The OS turns it into a governed read-only query, runs it, and answers from the actual rows. Check the numbers before you share.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.publish,
      title: 'Share it',
      body: 'The Sharing block is the first thing on Publish: "Promote to Domain →" files a request an approver confirms in Governance; an Admin can "Certify to Company →". Below it, the connected Metrics, Dashboards, and agent systems each offer a "＋ New … →" shortcut.',
      governedWrite: true,
      route: '/data',
    },
  ],

  sandbox: {
    lane: 'My Data',
    anchor: ANCHORS.data.sandbox,
    note: 'My Data is your private space — ingest, clean, and explore freely without affecting any shared domain data.',
  },

  outro: {
    title: 'Your first data product is live',
    body: 'You ingested, defined, harmonized, validated, and published a trusted data product. Next: define metrics on top of it, or turn it into a dashboard.',
    next: ['metrics', 'dashboards'],
    doc: 'data-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Use',
      hook: 'Explore and query the data products your domain trusts.',
    },
    creator: {
      verb: 'Create',
      hook: 'Turn your raw files into clean, documented, shareable data products.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review, promote, and certify data products for your domain and the company.',
    },
  },
};

export default data;
