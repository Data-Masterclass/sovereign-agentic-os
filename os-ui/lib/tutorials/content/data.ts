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
    body: 'One artifact, two surfaces. ＋ New picks the type — ingest data you bring in, or curate a new table from datasets you already trust — and lands you in Edit. Fill the sections, and the business layer materializes on its own. Then a full-page View lets you talk to the data, preview it, and check its quality — so your team and your agents always work from the same trusted numbers.',
    byRole: {
      builder: {
        body: 'One artifact, two surfaces. ＋ New picks the type — ingested or curated — and lands you in Edit. Fill the sections, let the business layer materialize, then promote and certify from the header — so your domain always works from one trusted source of truth.',
      },
    },
  },

  steps: [
    {
      illustration: 'load',
      title: 'New — pick the type',
      body: 'Start with "＋ New". Choose "📥 Ingest new data" to bring in a file (CSV, Parquet, JSON…), or "🔗 Create a curated dataset" to compose a new table from datasets you already have. A domain admin gets a third card — "🔗 From a connection" — to adopt a warehouse or operational table a platform admin has exposed to their domain. Either way you land in Edit, and tiles group into Ingested Data and Curated Data. (Data from an external lakehouse arrives governed, via a connection — not by ingest.)',
    },
    {
      illustration: 'clean',
      title: 'Edit an ingested dataset',
      body: 'The sections run Ingestion → Documentation → Transformation → Checks, each with its own Save. Land the data, describe it and its columns ("Save Documentation"), optionally clean it ("Save Transformations"). A clean single source needs no join — the business layer materializes automatically, no manual Gold step.',
    },
    {
      illustration: 'build',
      title: 'Or curate — compose a table',
      body: 'A curated dataset opens on Composition: pick an explicit base dataset, join in others you can read, keep or rename columns, and add derived fields — then "Save Composition". Documentation and Checks follow. Curated is the only place datasets join; ingested data never does.',
    },
    {
      illustration: 'governance',
      title: 'Checks — prove the quality',
      body: 'In the Checks section, accept the suggested rules from the profile or add your own, then "Save Data Quality Checks" for a real pass/fail per rule and a quality scorecard. The View shows where every number came from; lineage lives in the Developer view.',
    },
    {
      illustration: 'publish',
      title: 'View, then share it',
      body: 'Open the tile to View: Talk to Data in plain language, preview it (toggle the layer — Gold by default), read its statistics and quality scorecard. Until it is shared it shows a "not certified" chip. Promote from the header: "Promote to Domain →" files a request an approver confirms; an Admin can "Certify to Company →".',
      byRole: {
        creator: {
          body: 'Open the tile to View: Talk to Data in plain language, preview it (Gold by default), read its statistics and quality scorecard. It shows a "not certified" chip until shared. "Promote to Domain →" from the header files a request an approver confirms in Governance.',
        },
        builder: {
          body: 'Open the tile to View: Talk to Data, preview, and read the quality scorecard. Then share from the header — approve promotions for your domain, or "Certify to Company →" as Admin — and see every metric, dashboard, and agent system built on this dataset.',
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.data.sandbox,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Open your datasets',
      body: 'Home shows All, My, Domain, and Company data, with tiles grouped into Ingested Data and Curated Data. My Data is your private space — practice here without touching anything shared. The sidebar "Domain:" picker narrows everything to one domain; "All domains" restores the full view.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.load,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'New — ingest the data',
      body: 'Start with "＋ New" and pick a type. "📥 Ingest new data" lands you in Edit on the Ingestion section — upload a file, check the preview, and your data lands as a versioned table ready to shape. External lakehouse data comes in a different way: governed, via a connection — a domain admin adopts an exposed table with "🔗 From a connection", and it enters already curated at Domain tier (no bronze, no refine).',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.document,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Document it',
      body: 'In the Documentation section, answer "What is this dataset?" and fill in the column meanings, then "Save Documentation". Documented data is discoverable — and documentation is the gate for sharing later.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.clean,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Transformation — clean it up',
      body: 'The Transformation section is optional: rename, cast, trim, filter or dedupe, then "Save Transformations". A clean ingested dataset needs no join — the business layer materializes automatically, with no manual Gold step.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.harmonize,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Or curate — Composition',
      body: 'A curated dataset opens on Composition: pick an explicit base dataset, join in others you can see, keep or rename columns, add derived fields, then "Save Composition". Curated datasets are the only place data joins; ingested data never does.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.validate,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Checks — the quality gate',
      body: 'In the Checks section, accept the suggested rules or add your own, then "Save Data Quality Checks" — a real pass/fail per rule and a quality scorecard against the built table.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.query,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'View — ask your data, then share it',
      body: 'Open the tile to View: Talk to Data in plain language — "What was revenue last month?" — then preview it (toggle the layer, Gold by default), read the statistics and quality scorecard. A "not certified" chip shows until it is shared; when the numbers look right, promote from the header — "Promote to Domain →" files a request an approver confirms, and an Admin can "Certify to Company →".',
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
    body: 'You ingested (or curated), documented, checked, and shared a trusted data product — with its business layer materialized for you. Next: define metrics on top of it, or turn it into a dashboard.',
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
