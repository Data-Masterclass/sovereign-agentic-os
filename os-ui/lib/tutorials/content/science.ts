/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const science: TutorialDef = {
  key: 'science',
  route: '/science',
  title: 'Science',
  tagline: 'Train a model on your governed data in three plain stages — Design, Launch, Monitor.',
  buttonLabel: 'Science Tutorial',
  hook: {
    illustration: 'model',
    title: 'Classic ML, without the machinery',
    body: 'Describe what you want to predict, press "Train & launch", and watch the model go live — then try it on a real row. Science trains classification and regression on CPU and picks the algorithm, metric and split for you; there is nothing to tune. It is classic ML (not LLMs), off by default, because compute costs real money.',
  },
  steps: [
    {
      illustration: 'model',
      title: 'Design — say what you want to predict',
      body: 'Design is chat-first: tell the assistant what you want to predict and it proposes a model grounded in the datasets you were actually granted. It can only name a dataset or column you can really see — a hallucinated one is refused. Prefer to do it by hand? The manual form is one click away: pick a dataset, then choose the target and features as column pickers.',
    },
    {
      illustration: 'build',
      title: 'Launch — Train & launch in one step',
      body: 'One "Train & launch" button reads the data, trains, and puts the model live — a single fused action, shown as a plain timeline (reading data → training → publishing). The trained score is stated in business language (e.g. "typical error ±NN") and only once a run has really produced it. A failed rollout says so and offers a retry — never a faked deploy.',
    },
    {
      illustration: 'sandbox',
      title: 'Monitor — try it, watch it, govern it',
      body: 'Monitor scores the deployed model on a real example from your data and gives a plain verdict. It shows live serving health, the real call count (allowed and denied), and a score-distribution chart that stays honestly empty until something is scored. No invented drift badges.',
    },
    {
      illustration: 'publish',
      title: 'Promote it up the ladder',
      body: 'Sharing widens who may CALL the model up the same My → Domain → Company ladder as every other artifact. Promote to Domain for your team; an Admin certifies to Company. Promotion is the only thing that widens callable scope — governance travels with the model.',
      byRole: {
        builder: {
          body: 'You review and approve model promotions to Domain; an Admin certifies to Company. Promotion widens who may call the model — governance travels with it.',
        },
      },
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.science.sandbox,
      sandboxAnchor: ANCHORS.science.sandbox,
      route: '/science',
      title: 'Open your models',
      body: 'The scope buttons — All, My, Domain, Company — say whose models you see. My models are your private lane. If Science is off, the tab says so honestly — an Admin enables Layer 4 per domain.',
    },
    {
      anchor: ANCHORS.science.define,
      sandboxAnchor: ANCHORS.science.sandbox,
      route: '/science',
      title: 'Design a model',
      body: '"＋ New model" opens the Design stage: describe what you want to predict in chat, or use the manual form to pick a dataset and choose the target and feature columns. The algorithm, metric and split are chosen for you — nothing to tune.',
    },
    {
      anchor: ANCHORS.science.predict,
      sandboxAnchor: ANCHORS.science.sandbox,
      route: '/science',
      title: 'Launch, then try it in Monitor',
      body: 'Press "Train & launch" and watch the timeline carry the model from reading data to live. Once it is deployed, Monitor lets you score a real example and read a plain verdict, alongside live health and real usage.',
    },
    {
      anchor: ANCHORS.science.promote,
      route: '/science',
      governedWrite: true,
      title: 'Promote the model',
      body: 'Promote to Domain — approved in Policies & Approvals — and the domain can call it; an Admin certifies to Company. The visibility tier decides who may call the model.',
    },
  ],
  sandbox: {
    lane: 'My models — personal lane',
    anchor: ANCHORS.science.sandbox,
    note: 'Design, launch and try models privately; nothing widens access until a promotion is approved. Science itself is off by default — an Admin enables Layer 4 per domain.',
  },
  outro: {
    title: 'You shipped a model',
    body: 'Your model is live and callable through one governed path — with the same ladder and controls as every other artifact. Next: feed it better data, or wire its predictions into an agent.',
    next: ['data', 'agents'],
    doc: 'science-golden-path.md',
  },
  framing: {
    user: {
      verb: 'Use',
      hook: 'Call a trusted model\'s predictions from your apps and agents.',
    },
    creator: {
      verb: 'Create',
      hook: 'Design a model on your governed data, launch it, and try it in Monitor.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Approve model promotions — the visibility tier decides who may call the model.',
    },
  },
};

export default science;
