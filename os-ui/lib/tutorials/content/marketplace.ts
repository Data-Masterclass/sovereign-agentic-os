/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const marketplace: TutorialDef = {
  key: 'marketplace',
  route: '/marketplace',
  title: 'Marketplace',
  tagline: 'Discover and reuse certified products from every domain.',
  hook: {
    illustration: 'marketplace',
    title: 'Reuse what other teams already built',
    body: 'Discover certified products from every domain (data, metrics, dashboards, knowledge, agents and more), judge their trust signals, and import what you need as a governed grant under your own access.',
  },
  steps: [
    {
      illustration: 'marketplace',
      title: 'Browse the catalog',
      body: 'Search and filter by type, domain, or tag. Anyone can browse the certified products across the organization.',
    },
    {
      illustration: 'document',
      title: 'Inspect before you trust',
      body: 'Each listing shows its certification badge, owner, lineage, freshness, usage, and a preview, so you can judge it before importing.',
    },
    {
      illustration: 'governance',
      title: 'Request access',
      body: 'Import as a governed grant: you consume the shared product under your own identity and row-level security. If it needs approval, your request appears in Governance.',
      byRole: {
        builder: {
          body: 'You govern what your domain brings in. Imports are grants under your own row-level security, and approval-required requests surface in Governance for review.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.marketplace.sandbox,
      sandboxAnchor: ANCHORS.marketplace.sandbox,
      route: '/marketplace',
      title: 'Open your browsing lane',
      body: 'Start in a safe browsing view. Look around the catalog without importing anything.',
    },
    {
      anchor: ANCHORS.marketplace.browse,
      sandboxAnchor: ANCHORS.marketplace.sandbox,
      route: '/marketplace',
      title: 'Browse and filter',
      body: 'Search and filter by type, domain, or tag to find a certified product worth reusing.',
    },
    {
      anchor: ANCHORS.marketplace.inspect,
      sandboxAnchor: ANCHORS.marketplace.sandbox,
      route: '/marketplace',
      title: 'Inspect a listing',
      body: 'Open a listing and read its badge, owner, lineage, freshness, usage, and preview to judge trust.',
    },
    {
      anchor: ANCHORS.marketplace.request,
      route: '/marketplace',
      governedWrite: true,
      title: 'Request to import',
      body: 'Request a governed grant. You consume the shared product under your own row-level security; if approval is needed it appears in Governance.',
    },
  ],
  sandbox: {
    lane: 'Browse only - no imports',
    anchor: ANCHORS.marketplace.sandbox,
    note: 'Explore listings and previews freely; nothing is imported and no grant is requested until you graduate.',
  },
  outro: {
    title: 'You found something to reuse',
    body: 'Importing is a governed grant, so the owner stays the source of truth and you see only your own rows. Next, import data products, or reuse shared knowledge.',
    next: ['data', 'knowledge'],
    doc: 'marketplace-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Browse',
      hook: 'Find and reuse a certified product without rebuilding it.',
    },
    creator: {
      verb: 'Import',
      hook: 'Import a product as a grant, or fork it to tailor for your domain.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Review import requests and govern what your domain brings in.',
    },
  },
};

export default marketplace;
