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
      body: 'Drag files in or click Upload — any type works, with a live progress bar per file. Text is extracted in the background; the status chip flips from "Processing…" to "Searchable ✓" when a file is ready to find.',
    },
    {
      illustration: 'document',
      title: 'Preview and manage',
      body: 'Click a file for a full-screen quick look — PDFs carry their own badge. The manage row is always at hand: "Move to folder…", Archive, and the Sharing row. Files live in folders under "My folders" and "Domain folders", just like the other tabs.',
    },
    {
      illustration: 'knowledge',
      title: 'Find it again',
      body: 'Search runs across names, tags, and the extracted content itself — or narrow by folder and tag. You search what a file says, not just what it is called.',
    },
    {
      illustration: 'publish',
      title: 'Share it deliberately',
      body: 'Files climb the ladder My → Domain → Company. As the owner you "Propose to Domain →"; a domain admin approves it; an Admin can "Certify to Company →". For many files at once, "Select all" and promote or archive in bulk. Nothing leaves your drive by accident.',
      byRole: {
        builder: {
          body: 'Files climb the ladder My → Domain → Company. Owners propose the promotion and a domain admin approves it — the same two-step trust model as Data. An Admin certifies to Company. Bulk select-all promotes or archives many files at once.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.files.sandbox,
      sandboxAnchor: ANCHORS.files.sandbox,
      route: '/unstructured',
      title: 'Start in My Files',
      body: 'The scope buttons — All, My, Domain, Company — say whose files you see. My Files is your private drive: everything you upload lands here, invisible to anyone else until a promotion is approved.',
    },
    {
      anchor: ANCHORS.files.upload,
      sandboxAnchor: ANCHORS.files.sandbox,
      route: '/unstructured',
      title: 'Upload a file',
      body: 'Click Upload or drag files anywhere onto the grid — a progress bar tracks each one. Watch the chip: "Processing…" means the text is being extracted; "Searchable ✓" means it is indexed and findable.',
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
      title: 'Propose to share',
      body: 'Open a file: the quick look shows its Sharing row alongside "Move to folder…" and Archive. Add the description it asks for, then "Propose to Domain →" — a domain admin approves it, the deliberate yes that makes sharing safe. Many files? "Select all" and promote or archive in bulk.',
    },
  ],
  sandbox: {
    lane: 'My Files — your private drive',
    anchor: ANCHORS.files.sandbox,
    note: 'Uploads land private to you. Explore, tag, and search freely; nothing is shared until a domain admin approves a promotion.',
  },
  outro: {
    title: 'Your drive is governed',
    body: 'You uploaded, previewed, and found a file — and you know the ladder that shares it: you propose, a domain admin approves, an Admin certifies to Company. Next, distil a file into Knowledge, or seed a dataset from it in Data.',
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
      hook: 'Approve what becomes Domain and keep sensitivity honest.',
    },
  },
};

export default files;
