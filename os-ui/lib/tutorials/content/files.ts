/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const files: TutorialDef = {
  key: 'files',
  route: '/unstructured',
  title: 'Files',
  tagline: 'A governed drive: upload anything, find it again, share it deliberately.',
  buttonLabel: 'Files Tutorial',
  hook: {
    illustration: 'document',
    title: 'Your working files, findable and governed',
    body: 'Drop in any file — documents, images, audio, video. The OS extracts the text, makes it searchable, and keeps it private until you deliberately share it. No folders full of copies, no email attachments.',
  },
  steps: [
    {
      illustration: 'load',
      title: 'Upload anything',
      body: 'Drag a file in or click Upload — any type works. Text is extracted and indexed in the background; the status chip flips from Processing to Searchable when it is ready to find.',
    },
    {
      illustration: 'document',
      title: 'Describe it',
      body: 'Add a short description, a few tags, and a sensitivity level (public to restricted). Restricted files are never indexed. A described file is a shareable file — and one your future self can find.',
    },
    {
      illustration: 'knowledge',
      title: 'Find it again',
      body: 'Search runs across names, tags, and the extracted content itself — or narrow by folder and tag. You search what a file says, not just what it is called.',
    },
    {
      illustration: 'publish',
      title: 'Share it deliberately',
      body: 'Files climb a ladder: personal, then shared in your domain, then certified to the Marketplace. As the owner you request the promotion; a domain Builder approves it; an Admin certifies. Nothing leaves your drive by accident.',
      byRole: {
        builder: {
          body: 'Files climb a ladder: personal, domain, Marketplace. Owners request the promotion and you approve it for your domain — the same two-step trust model as Data. An Admin certifies to the Marketplace.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.files.sandbox,
      sandboxAnchor: ANCHORS.files.sandbox,
      route: '/unstructured',
      title: 'Start in your personal drive',
      body: 'Everything you upload lands here, private to you. Practice freely — nothing is visible to anyone else until a promotion is approved.',
    },
    {
      anchor: ANCHORS.files.upload,
      sandboxAnchor: ANCHORS.files.sandbox,
      route: '/unstructured',
      title: 'Upload a file',
      body: 'Click Upload or drag a file anywhere onto the grid. Watch the chip: Processing means the text is being extracted; Searchable means it is indexed and findable.',
    },
    {
      anchor: ANCHORS.files.search,
      sandboxAnchor: ANCHORS.files.sandbox,
      route: '/unstructured',
      title: 'Search across content',
      body: 'Type a phrase from inside the file — not its name. The hit comes back with a snippet, because search reads the extracted text.',
    },
    {
      anchor: ANCHORS.files.share,
      route: '/unstructured',
      governedWrite: true,
      title: 'Request to share',
      body: 'Open a file and use the Sharing panel: add the description it asks for, then request promotion to your domain. A domain Builder approves it in Governance — the deliberate yes that makes sharing safe.',
    },
  ],
  sandbox: {
    lane: 'Personal files - your private drive',
    anchor: ANCHORS.files.sandbox,
    note: 'Uploads land private to you. Explore, tag, and search freely; nothing is shared until a Builder approves a promotion.',
  },
  outro: {
    title: 'Your drive is governed',
    body: 'You uploaded, described, and found a file — and you know the ladder that shares it: owner requests, Builder approves, Admin certifies. Next, distil a file into Knowledge, or seed a dataset from it in Data.',
    next: ['knowledge', 'data'],
    doc: 'files-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Find',
      hook: 'Search and preview the files shared with your domain.',
    },
    creator: {
      verb: 'Upload',
      hook: 'Keep your working files in one governed, searchable drive.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Approve what becomes domain-shared and keep sensitivity honest.',
    },
  },
};

export default files;
