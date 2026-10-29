/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverPages, generateSectionsContent, ensureSectionsRegistered, unregisteredPageHints } from './sections-registry.ts';

const shell = { path: 'src/template/shell.tsx', content: 'shell' };
const sectionsPlaceholder = {
  path: 'src/template/sections.tsx',
  content: 'export const SECTIONS = [{ id: "overview" }, { id: "workspace" }];',
};

const pageA = { path: 'src/epics/radar/live-opportunities/LiveOpportunities.tsx', content: 'export default function LiveOpportunities(){return null}' };
const pageB = { path: 'src/epics/radar/live-dossier/LiveDossier.tsx', content: 'export default function LiveDossier(){return null}' };
const pageC = { path: 'src/epics/decision-governance/fall-entscheid/DecisionPage.tsx', content: 'export default function DecisionPage(){return null}' };
const generalHelper = { path: 'src/epics/radar/general/index.ts', content: 'export const x = 1' };
const nested = { path: 'src/epics/radar/live-dossier/parts/Sub.tsx', content: 'export default function Sub(){return null}' };
const lower = { path: 'src/epics/radar/live-dossier/helpers.ts', content: 'export const h = 1' };

test('discoverPages: one PascalCase page per story folder; excludes general/, nested, and non-page files', () => {
  const pages = discoverPages([pageA, pageB, pageC, generalHelper, nested, lower]);
  assert.deepEqual(
    pages.map((p) => p.file).sort(),
    [
      'src/epics/decision-governance/fall-entscheid/DecisionPage.tsx',
      'src/epics/radar/live-dossier/LiveDossier.tsx',
      'src/epics/radar/live-opportunities/LiveOpportunities.tsx',
    ],
  );
});

test('generateSectionsContent: registers Overview + every story page, imports relative to template/', () => {
  const out = generateSectionsContent([shell, sectionsPlaceholder, pageA, pageB, pageC])!;
  assert.match(out, /import Overview from '\.\/pages\/Overview\.tsx';/);
  assert.match(out, /import S0 from '\.\.\/epics\/decision-governance\/fall-entscheid\/DecisionPage\.tsx';/);
  assert.match(out, /export const SECTIONS: AppSection\[\]/);
  assert.match(out, /id: 'overview'/);
  assert.match(out, /label: "Fall Entscheid"/); // humanized story folder
  assert.match(out, /label: "Live Dossier"/);
  assert.match(out, /label: "Live Opportunities"/);
  // No leftover placeholder.
  assert.doesNotMatch(out, /workspace/);
});

test('generateSectionsContent: humanizes PascalCase/camelCase and de-shouts ALL-CAPS story folders', () => {
  const pascal = { path: 'src/epics/service/AssignNewCaseToServiceCenter/AssignNewCaseToServiceCenter.tsx', content: 'export default function AssignNewCaseToServiceCenter(){return null}' };
  const shout = { path: 'src/epics/service/ASSIGNNEWSERVICECASETOEMPLOYEE/Page.tsx', content: 'export default function Page(){return null}' };
  const out = generateSectionsContent([shell, sectionsPlaceholder, pascal, shout])!;
  assert.match(out, /label: "Assign New Case To Service Center"/); // PascalCase → spaced words
  assert.match(out, /label: "Assignnewservicecasetoemployee"/); // ALL-CAPS de-shouted, not SHOUTING
  assert.doesNotMatch(out, /label: "ASSIGNNEWSERVICECASETOEMPLOYEE"/); // never a shouting LABEL
});

test('generateSectionsContent: null for a non-sovereign-app (no template shell) or when no pages built', () => {
  assert.equal(generateSectionsContent([pageA, pageB]), null, 'no template shell → not applicable');
  assert.equal(generateSectionsContent([shell, sectionsPlaceholder]), null, 'no pages → keep the scaffold default');
});

test('ensureSectionsRegistered: augments the changeset with a regenerated sections.tsx when a page is added', () => {
  const prior = [shell, sectionsPlaceholder];
  const changeset = [pageC]; // a new story page, but the agent forgot to touch sections.tsx
  const out = ensureSectionsRegistered(prior, changeset, 'sovereign-app');
  const sec = out.find((f) => f.path === 'src/template/sections.tsx');
  assert.ok(sec, 'sections.tsx is added to the commit');
  assert.match(sec!.content, /DecisionPage\.tsx/);
  assert.ok(out.some((f) => f.path === pageC.path), 'the page itself is still committed');
});

test('ensureSectionsRegistered: no-op for a non-sovereign-app template', () => {
  const out = ensureSectionsRegistered([shell, sectionsPlaceholder], [pageC], 'nextjs-supabase');
  assert.deepEqual(out, [pageC]);
});

test('ensureSectionsRegistered: no-op when sections.tsx is already exactly the generated content', () => {
  const prior = [shell, sectionsPlaceholder, pageA];
  const desired = generateSectionsContent([shell, sectionsPlaceholder, pageA])!;
  const priorWithGen = [shell, { path: 'src/template/sections.tsx', content: desired }, pageA];
  // Re-committing pageA with the registry already correct → nothing added.
  const out = ensureSectionsRegistered(priorWithGen, [pageA], 'sovereign-app');
  assert.deepEqual(out, [pageA], 'already-correct registry is left untouched');
});

// -------------------- off-pattern page hints (0.6.115 C3) --

test('C3: a valid PascalCase page produces NO registration hint', () => {
  const hints = unregisteredPageHints([pageA, pageB, pageC]);
  assert.deepEqual(hints, [], 'canonical pages register cleanly — no hint');
});

test('C3: a lowercase-first page (e.g. index.tsx) is flagged as unregisterable', () => {
  const off = { path: 'src/epics/radar/live-opportunities/index.tsx', content: 'export default function I(){return null}' };
  const hints = unregisteredPageHints([off]);
  assert.equal(hints.length, 1, 'one hint');
  assert.match(hints[0], /index\.tsx/);
  assert.match(hints[0], /UPPERCASE|PascalCase/i, 'names the PascalCase requirement');
});

test('C3: a wrong-depth .tsx under src/epics/ is flagged', () => {
  const shallow = { path: 'src/epics/radar/Page.tsx', content: 'export default function P(){return null}' };
  const deep = { path: 'src/epics/radar/story/parts/Page.tsx', content: 'export default function P(){return null}' };
  const hints = unregisteredPageHints([shallow, deep]);
  assert.equal(hints.length, 2, 'both wrong-depth files flagged');
  for (const h of hints) assert.match(h, /depth 4|src\/epics\/<epic>\/<story>/);
});

test('C3: a 2nd PascalCase page in the same story folder is flagged (only the first path-sorted registers)', () => {
  // Zebra.tsx sorts AFTER LiveOpportunities.tsx, so LiveOpportunities registers (matches
  // discoverPages: first path-sorted wins) and Zebra is the one flagged as unregisterable.
  const second = { path: 'src/epics/radar/live-opportunities/Zebra.tsx', content: 'export default function Z(){return null}' };
  const hints = unregisteredPageHints([pageA, second]);
  assert.equal(hints.length, 1, 'the second page is flagged');
  assert.match(hints[0], /Zebra\.tsx/, 'the path-later page is the one that will not register');
  assert.match(hints[0], /ONE page|only the first/i);
});

test('C3: general/ and non-.tsx helpers are never flagged (they are intentionally not pages)', () => {
  assert.deepEqual(unregisteredPageHints([generalHelper, lower]), [], 'general/ + .ts helpers ignored');
});
