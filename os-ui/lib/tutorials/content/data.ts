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

  hook: {
    illustration: 'load',
    title: 'From raw file to trusted data product',
    body: 'Upload a CSV, clean it up, document it, and publish it — so your team and your agents always work from the same certified numbers.',
    byRole: {
      builder: {
        body: 'Upload, clean, document, and certify — so your domain always works from one trusted source of truth.',
      },
    },
  },

  steps: [
    {
      illustration: 'load',
      title: 'Load your data',
      body: 'Upload a CSV, Parquet, or Excel file — or point to a connection or a Supabase table. Your data lands as a raw versioned table, ready to shape.',
    },
    {
      illustration: 'clean',
      title: 'Clean and shape it',
      body: 'Pick a template — "clean and type", "join two products", "aggregate to daily" — or describe the transform in plain language. Preview the result before committing; nothing saves until you confirm.',
    },
    {
      illustration: 'document',
      title: 'Document it',
      body: 'Give it a name, a description, an owner, and a visibility level. Add plain-English definitions for the key columns. Now anyone who finds it knows exactly what it is and who to ask.',
    },
    {
      illustration: 'publish',
      title: 'Publish as a data product',
      body: 'A Builder certifies and promotes it to the catalog and Marketplace. Every dashboard and agent now shares one authoritative source — and the numbers match.',
      byRole: {
        creator: {
          body: 'Submit for Builder review. Once certified it lands in the catalog and Marketplace — one authoritative source everyone can trust.',
        },
        builder: {
          body: 'Review, certify, and publish. The product lands in the catalog and Marketplace, ready for dashboards, agents, and cross-domain use.',
        },
      },
    },
  ],

  walkthrough: [
    {
      anchor: ANCHORS.data.sandbox,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Open your personal lane',
      body: 'Practice here without touching governed data. Your personal lane is private, ungoverned, and safe to explore.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.load,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Load your data',
      body: 'Upload a file or pick from your connections. It lands as a raw table — versioned, cataloged, and waiting to be shaped.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.clean,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Clean and shape',
      body: 'Pick a transform template or describe what you want in plain language. Preview the result — nothing commits until you confirm.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.document,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Document it',
      body: 'Name it, describe it, set a visibility level, and add column definitions. Documented data is discoverable and trustworthy.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.query,
      sandboxAnchor: ANCHORS.data.sandbox,
      title: 'Query and verify',
      body: 'Run a quick query to confirm the numbers look right. This is the same table your dashboards and agents will use — check it before publishing.',
      route: '/data',
    },
    {
      anchor: ANCHORS.data.publish,
      title: 'Publish as a data product',
      body: 'Certify and publish. The product lands in the catalog and Marketplace. Every dashboard and agent now shares one authoritative source.',
      governedWrite: true,
      roles: ['builder'],
      route: '/data',
    },
  ],

  sandbox: {
    lane: 'Personal data',
    anchor: ANCHORS.data.sandbox,
    note: 'Your personal lane is private and ungoverned — upload, clean, and explore freely without affecting any shared domain data.',
  },

  outro: {
    title: 'Your first data product is live',
    body: 'You loaded, cleaned, documented, and published a trusted data product. Next: define metrics on top of it, or turn it into a dashboard.',
    next: ['metrics', 'dashboards'],
    doc: 'data-golden-path.md',
  },

  framing: {
    user: {
      verb: 'Use',
      hook: 'Explore and query the data products your domain certifies.',
    },
    creator: {
      verb: 'Create',
      hook: 'Turn your raw files into clean, documented, shareable data products.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review, certify, and publish data products to the domain catalog and Marketplace.',
    },
  },
};

export default data;
