/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import type { TutorialDef } from '../types';
import { ANCHORS } from '../anchors';

const science: TutorialDef = {
  key: 'science',
  route: '/science',
  title: 'Science',
  tagline: 'Traditional ML as a governed service — define, predict, promote.',
  buttonLabel: 'Science Tutorial',
  hook: {
    illustration: 'model',
    title: 'Model-as-a-service, governed like everything else',
    body: 'Define a model over your governed data, try its predict front door, then promote it up the same My → Domain → Company ladder that governs every other artifact. This is classic ML (not LLMs) — and it is off by default, because GPUs cost real money.',
  },
  steps: [
    {
      illustration: 'model',
      title: 'Define a model',
      body: '"＋ New model" starts from a governed dataset: name the model, say what it predicts, and define it as a service. No raw credentials, no side channels — the model reads the same governed data you do.',
    },
    {
      illustration: 'sandbox',
      title: 'Try the predict front door',
      body: 'Open a model and use its Predict surface: send it inputs, read its predictions. The same endpoint serves your apps as a REST predict and your agents as a governed tool — one front door, every caller authorized.',
    },
    {
      illustration: 'publish',
      title: 'Promote it up the ladder',
      body: 'Models climb the same ladder as data: promote to Domain for your team, certify to Company for the org. Promotion widens who may call the predict endpoint — governance travels with the model.',
      byRole: {
        builder: {
          body: 'You review and approve model promotions to Domain; an Admin certifies to Company. Promotion widens who may call the predict endpoint — governance travels with the model.',
        },
      },
    },
    {
      illustration: 'build',
      title: 'The raw stack, when you need it',
      body: 'Under the hood sit MLflow, Featureform, JupyterHub, and KServe — one click away in the Developer console. Science is Layer 4: off by default and GPU-cost-gated; an Admin enables it per domain.',
    },
  ],
  walkthrough: [
    {
      anchor: ANCHORS.science.sandbox,
      sandboxAnchor: ANCHORS.science.sandbox,
      route: '/science',
      title: 'Open your models',
      body: 'The scope buttons — All, My, Domain, Company — say whose models you see. My models are your private lane; nothing here touches governed models.',
    },
    {
      anchor: ANCHORS.science.define,
      sandboxAnchor: ANCHORS.science.sandbox,
      route: '/science',
      title: 'Define a model',
      body: '"＋ New model": pick a governed dataset and define what the model predicts. It becomes a service with a governed front door from the moment it exists.',
    },
    {
      anchor: ANCHORS.science.predict,
      sandboxAnchor: ANCHORS.science.sandbox,
      route: '/science',
      title: 'Try a prediction',
      body: 'Open the model and use Predict: send inputs, read predictions. This is the same endpoint your apps call as REST and your agents call as a tool.',
    },
    {
      anchor: ANCHORS.science.promote,
      route: '/science',
      governedWrite: true,
      title: 'Promote the model',
      body: 'Promote to Domain — approved in Policies & Approvals — and the domain can call it; an Admin certifies to Company. The visibility tier decides who may call predict.',
    },
  ],
  sandbox: {
    lane: 'My models — personal lane',
    anchor: ANCHORS.science.sandbox,
    note: 'Define and try models privately; nothing widens access until a promotion is approved. Science itself is off by default — an Admin enables Layer 4 per domain.',
  },
  outro: {
    title: 'You shipped a model',
    body: 'Your model serves predictions through one governed front door, with the same ladder and controls as every other artifact. Next: feed it better data, or wire it into an agent.',
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
      hook: 'Define a model over governed data and try its predict front door.',
    },
    builder: {
      verb: 'Review & promote',
      hook: 'Approve model promotions — the visibility tier decides who may call predict.',
    },
  },
};

export default science;
