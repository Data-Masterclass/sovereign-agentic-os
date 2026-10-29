/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asChatRunMode, isReadOnlyMode, modeDirective, modelRoleForMode, tierNote, READ_ONLY_MODE_TOOLS, BUILD_MODE_TOOLS, BUILD_PRINCIPLES, CODE_STRUCTURE_CONVENTION, DATA_PLANE_CONTRACT } from './chat-modes.ts';

test('tier policy: ALL software stages run on the reasoning model', () => {
  assert.equal(modelRoleForMode('plan'), 'reasoning');
  assert.equal(modelRoleForMode('test'), 'reasoning');
  assert.equal(modelRoleForMode('review'), 'reasoning');
  // Build (code generation) now runs on reasoning too — standard proved too weak for codegen.
  assert.equal(modelRoleForMode('build'), 'reasoning');
});

test('tier note is an honest label', () => {
  assert.equal(tierNote('reasoning'), 'reasoning model');
  assert.equal(tierNote('standard'), 'standard model');
});

test('asChatRunMode: valid modes pass through; anything else defaults to build', () => {
  for (const m of ['plan', 'build', 'test', 'review'] as const) assert.equal(asChatRunMode(m), m);
  assert.equal(asChatRunMode(undefined), 'build');
  assert.equal(asChatRunMode('deploy'), 'build');
  assert.equal(asChatRunMode(42), 'build');
});

test('isReadOnlyMode: every mode except build is read-only (harness-enforced)', () => {
  assert.equal(isReadOnlyMode('build'), false);
  assert.equal(isReadOnlyMode('plan'), true);
  assert.equal(isReadOnlyMode('test'), true);
  assert.equal(isReadOnlyMode('review'), true);
});

test('READ_ONLY_MODE_TOOLS: no write/mutating tool in the allowlist', () => {
  for (const t of READ_ONLY_MODE_TOOLS) {
    assert.ok(!/commit|preview|deploy|create|delete|promote/i.test(t), `${t} is read-only`);
  }
  assert.ok(READ_ONLY_MODE_TOOLS.includes('read_app_files'), 'test/review can ground themselves in the real files');
});

test('BUILD_MODE_TOOLS: WRITE-ONLY over frozen context — has commit + orientation, EXCLUDES data discovery/query (0.6.108)', () => {
  // The orientation set (READ_ONLY_MODE_TOOLS) is fully included so Build can read its own files/status.
  for (const t of READ_ONLY_MODE_TOOLS) assert.ok(BUILD_MODE_TOOLS.includes(t), `build keeps orientation tool ${t}`);
  // The one write door + the ability to read its own committed files.
  assert.ok(BUILD_MODE_TOOLS.includes('commit'), 'build can commit (the ONE write door)');
  assert.ok(BUILD_MODE_TOOLS.includes('read_app_files'), 'build can read its own committed files');
  // The whole point of the fix: NO data discovery / query / design tools in Build — context is
  // bound/created in Choose Context and frozen into the injected schema.
  for (const forbidden of ['list_datasets', 'profile_dataset', 'query_data', 'design_software', 'create_dataset', 'start_preview', 'request_deploy']) {
    assert.ok(!BUILD_MODE_TOOLS.includes(forbidden), `build must NOT have ${forbidden}`);
  }
  // get_dataset is the deliberate fallback (ColumnDoc carries no per-column type — the injected
  // schema has names+descriptions only, so Build can still fetch a granted dataset's exact types).
  assert.ok(BUILD_MODE_TOOLS.includes('get_dataset'), 'build keeps get_dataset as the column-type fallback');
});

test('modeDirective: each mode gets its own honest directive; build names the appId', () => {
  assert.match(modeDirective('plan', 'app_1').join('\n'), /PLAN.*read-only/s);
  assert.match(modeDirective('build', 'app_1').join('\n'), /appId \(app_1\)/);
  const t = modeDirective('test', 'app_1').join('\n');
  assert.match(t, /verifier/i);
  assert.match(t, /NEVER fabricate test execution/);
  assert.match(t, /read_app_files/);
  const r = modeDirective('review', 'app_1').join('\n');
  assert.match(r, /file-by-file/);
  assert.match(r, /never invent functionality/);
});

// --------------------------------------------------------- BUILD_PRINCIPLES --

test('BUILD_PRINCIPLES: exactly five one-line principles, one per Test dimension', () => {
  const lines = BUILD_PRINCIPLES.split('\n');
  assert.equal(lines.length, 5, 'exactly five principles');
  for (const l of lines) assert.ok(!l.includes('\n') && l.trim().length > 0, 'each is one non-empty line');
  // 1:1 with the five Test dimensions.
  assert.match(BUILD_PRINCIPLES, /Functionality/);
  assert.match(BUILD_PRINCIPLES, /User Experience/);
  assert.match(BUILD_PRINCIPLES, /Code Structure/);
  assert.match(BUILD_PRINCIPLES, /Security/);
  assert.match(BUILD_PRINCIPLES, /Documentation/);
});

// --------------------------------------------- data-plane contract (write SDK) --

test('DATA_PLANE_CONTRACT: names the TRUE write surface (os.records.*) and forbids the hallucinations', () => {
  // The one real write door.
  assert.match(DATA_PLANE_CONTRACT, /os\.records\.add\(record\)/);
  assert.match(DATA_PLANE_CONTRACT, /os\.records\.export\(\)/);
  // Datasets/metrics/knowledge/files are READS.
  assert.match(DATA_PLANE_CONTRACT, /datasets are READ-ONLY/);
  // The hallucinated methods are explicitly ruled out.
  assert.match(DATA_PLANE_CONTRACT, /NO os\.datasets\.update/);
  assert.match(DATA_PLANE_CONTRACT, /no\s*\n?\s*os\.files\.create|os\.files\.create/);
  // The exact import-depth contract from a story folder.
  assert.match(DATA_PLANE_CONTRACT, /import \{ os \} from '\.\.\/\.\.\/\.\.\/core\/store'/);
  // The multi-file gate rule.
  assert.match(DATA_PLANE_CONTRACT, /fix EVERY listed file/);
  // Envelope-gated writes are called out.
  assert.match(DATA_PLANE_CONTRACT, /APPROVED deploy envelope/);
});

test('modeDirective(build): carries the data-plane contract (the write SDK)', () => {
  const b = modeDirective('build', 'app_1').join('\n');
  assert.match(b, /os\.records\.add/);
  assert.match(b, /NO os\.datasets\.update/);
});

// --------------------------------------------- code-structure convention --

test('CODE_STRUCTURE_CONVENTION: names template/core/epics + thin app entrypoints', () => {
  assert.match(CODE_STRUCTURE_CONVENTION, /template\//);
  assert.match(CODE_STRUCTURE_CONVENTION, /core\//);
  assert.match(CODE_STRUCTURE_CONVENTION, /epics\/<epicKey>\/<storyKey>\//);
  assert.match(CODE_STRUCTURE_CONVENTION, /epics\/<epicKey>\/general\//);
  assert.match(CODE_STRUCTURE_CONVENTION, /THIN entrypoints/i);
  assert.match(CODE_STRUCTURE_CONVENTION, /governed data plane/i);
});

test('CODE_STRUCTURE_CONVENTION: the vendored-API guardrails that keep the compile gate green', () => {
  // The recurring live failures: importing react-router-dom, and wrapping a page in <AppShell>.
  // ONLY 3 import sources — and an explicit ban on routers / any 3rd-party lib.
  assert.match(CODE_STRUCTURE_CONVENTION, /ONLY 3 import sources/i, 'names the three-import-sources rule');
  assert.match(CODE_STRUCTURE_CONVENTION, /react-router-dom/, 'names the exact banned router import that bit us');
  assert.match(CODE_STRUCTURE_CONVENTION, /NEVER import anything else/i, 'bans all other 3rd-party libs');
  // Navigation is the section registry, not a client router.
  assert.match(CODE_STRUCTURE_CONVENTION, /no client-side router/i, 'no client-side router');
  assert.match(CODE_STRUCTURE_CONVENTION, /useNavigate/, 'names the exact router hook the agent reached for');
  // A page returns its CONTENT (Section/Card) and NEVER renders <AppShell> (template-only).
  assert.match(CODE_STRUCTURE_CONVENTION, /NEVER renders?\s+`?<AppShell>/i, 'pages must never render AppShell');
  assert.match(CODE_STRUCTURE_CONVENTION, /<Section /, 'shows a page returns Section content');
  assert.match(CODE_STRUCTURE_CONVENTION, /Overview\.tsx/, 'points at the correct example page to mirror');
  // The exact @sovereign-os/ui signatures that bit us (AppShell requires nav; Alert variant).
  assert.match(CODE_STRUCTURE_CONVENTION, /AppShell[^\n]*REQUIRES `nav`/i, 'notes AppShell requires nav (template-only)');
  assert.match(CODE_STRUCTURE_CONVENTION, /<Alert variant=/i, 'Alert takes variant');
  // The onChange handler: read e.currentTarget.value (already typed — NO `as` cast; A4/0.6.115).
  assert.match(CODE_STRUCTURE_CONVENTION, /e\.currentTarget\.value/i, 'reads onChange value from currentTarget (no cast)');
  assert.doesNotMatch(CODE_STRUCTURE_CONVENTION, /e\.target as HTMLSelectElement/i, 'no stale `as HTMLSelectElement` cast');
});

// ------------------------------------ Vite `src/` layout (0.6.115 — A1..A5) --

test('CODE_STRUCTURE_CONVENTION: teaches the Vite `src/` layout, NEVER a Next.js `app/` story location', () => {
  // Every folder ref carries the src/ prefix; the entrypoints are the Vite pair.
  assert.match(CODE_STRUCTURE_CONVENTION, /src\/template\//, 'src/template/');
  assert.match(CODE_STRUCTURE_CONVENTION, /src\/core\//, 'src/core/');
  assert.match(CODE_STRUCTURE_CONVENTION, /src\/epics\/<epicKey>\/<storyKey>\//, 'src/epics/<epic>/<story>/');
  assert.match(CODE_STRUCTURE_CONVENTION, /src\/main\.tsx/, 'names the Vite entry src/main.tsx');
  assert.match(CODE_STRUCTURE_CONVENTION, /src\/App\.tsx/, 'names src/App.tsx');
  // The contradiction that caused the same failure class as the useIdentity bug: NO app/ layout.
  assert.doesNotMatch(CODE_STRUCTURE_CONVENTION, /App-Router/i, 'no Next.js App-Router framing');
  assert.doesNotMatch(CODE_STRUCTURE_CONVENTION, /^\s*app\//m, 'no bare `app/` as a story location');
  assert.doesNotMatch(CODE_STRUCTURE_CONVENTION, /under `app\//, 'no "under app/" story-location claim');
});

test('CODE_STRUCTURE_CONVENTION: uses the slug-bound `os` singleton, never `createOsClient()` in a page', () => {
  assert.match(CODE_STRUCTURE_CONVENTION, /import \{ os \} from '\.\.\/\.\.\/\.\.\/core\/store'/, 'imports the singleton os');
  assert.match(CODE_STRUCTURE_CONVENTION, /createOsClient\(APP_SLUG\)/, 'created once as createOsClient(APP_SLUG)');
  assert.doesNotMatch(CODE_STRUCTURE_CONVENTION, /createOsClient\(\)\s*;?\s*\/\/|const os = createOsClient\(\)/, 'never a no-arg createOsClient() page example');
});

test('CODE_STRUCTURE_CONVENTION: auto-registration is scoped to sovereign-app + states the discovery rule', () => {
  assert.match(CODE_STRUCTURE_CONVENTION, /sovereign-app/, 'scopes the claim to sovereign-app');
  assert.match(CODE_STRUCTURE_CONVENTION, /<PascalCase>\.tsx/, 'PascalCase filename rule');
  assert.match(CODE_STRUCTURE_CONVENTION, /ONE\s+PascalCase page per story folder/i, 'one page per story folder');
  assert.match(CODE_STRUCTURE_CONVENTION, /general\/`?\s+folder is skipped/i, 'general/ skipped');
});

test('modeDirective(build): tells the agent to FIX rejected diagnostics, not resubmit unchanged code', () => {
  const b = modeDirective('build', 'app_1').join('\n');
  assert.match(b, /never resubmit (the same |unchanged )/i, 'forbids re-committing identical rejected code');
});

test('modeDirective(build): "done" is grounded in facts, and un-built stories must be BUILT (no false "already implemented")', () => {
  const b = modeDirective('build', 'app_1').join('\n');
  assert.match(b, /"DONE" IS GROUNDED IN FACTS, NEVER IN THE SPEC/i, 'done = facts, not spec');
  assert.match(b, /status:'done' AND committed source files/i, 'done requires status:done AND committed files');
  assert.match(b, /already implemented/i, 'names the false "already implemented" refusal');
  assert.match(b, /no further\s+build needed/i, 'names the "no further build needed" claim');
  assert.match(b, /BUILD IT/, 'un-built story must be built');
});

test('modeDirective(build): roles use useIdentity + roleAtLeast (a floor), never an exact-match block', () => {
  const b = modeDirective('build', 'app_1').join('\n');
  assert.match(b, /useIdentity\(\)/, 'gets the user from useIdentity');
  assert.match(b, /roleAtLeast\(user\.role, '<floor>'\)/, 'gates with the roleAtLeast floor helper');
  assert.match(b, /NEVER an exact match like[\s\S]*role === 'admin'/i, 'forbids the exact-match role block');
  assert.match(b, /creator < builder < domain_admin < admin/, 'states the real OS role ladder');
  assert.match(b, /ADVISORY UX/i, 'client checks are advisory, not enforcement');
  assert.match(b, /HIDE or DISABLE/i, 'hide/disable the control, not a blocking error');
  // 0.6.114: the BUILD directive must teach the discriminated-union contract and forbid
  // `const { id } = useIdentity()` (the TS2339 that loops the build agent).
  assert.match(b, /identity\.phase === 'ready'/, 'narrows on .phase === ready before touching .user');
  assert.match(b, /IdentityState/, 'names IdentityState as the union type');
  assert.match(b, /never `const \{ id \} = useIdentity\(\)`/, 'forbids destructuring a non-existent {id}');
  assert.doesNotMatch(b, /^\s*const \{ id \} = useIdentity\(\)/m, 'never shows a bare `const { id } = useIdentity()` example line');
});

// --------------------------------------- BUILD directive injects both --

test('modeDirective(build): injects BUILD_PRINCIPLES + the code-structure convention', () => {
  const b = modeDirective('build', 'app_1').join('\n');
  assert.ok(b.includes(BUILD_PRINCIPLES), 'build prompt carries the five build principles');
  assert.ok(b.includes(CODE_STRUCTURE_CONVENTION), 'build prompt carries the structure convention');
  assert.match(b, /epics\/<epic>\/<story>/, 'tells the model where story code goes');
});

test('modeDirective(build): carries the EXACT commit signature + worked example', () => {
  // Hardening for the file-less-commit failure: the model must see the exact shape and
  // that code goes in `files`, not prose. A terse worked example rides every build turn.
  const b = modeDirective('build', 'app_1').join('\n');
  assert.match(b, /commit\(\{ files: \[\{ path:/, 'the exact commit({ files: [{ path, content }] }) template is present');
  assert.match(b, /NOT in your prose/i, 'tells the model the source goes in files, not prose');
  assert.match(b, /BUILT[\s\S]*SUCCESSFUL commit/i, 'built-ness is earned by a real commit, not a claim');
});

test('modeDirective(build): forbids ending a failed build with an instructions essay', () => {
  const b = modeDirective('build', 'app_1').join('\n');
  assert.match(b, /do NOT write a step-by-step.*essay|essay/i, 'forbids the plan-essay wrap-up');
  assert.match(b, /honestly marked failed|marked failed/i, 'a turn that cannot commit is marked failed, not disguised');
});

// ------------------------------------ PLAN (Design draft) injects principles --

test('modeDirective(plan): the Design drafting prompt carries the build principles', () => {
  const p = modeDirective('plan', 'app_1').join('\n');
  assert.ok(p.includes(BUILD_PRINCIPLES), 'design drafts against the same principles it builds by');
});

// --------------------------------- TEST = true 5-dimension verification --

test('modeDirective(test): verifies across the five named dimensions with per-dim PASS/FAIL', () => {
  const t = modeDirective('test', 'app_1').join('\n');
  for (const dim of ['Functionality', 'User Experience', 'Code Structure', 'Security', 'Documentation']) {
    assert.match(t, new RegExp(dim), `checks ${dim}`);
  }
  assert.match(t, /PASS\/FAIL/i, 'reports PASS/FAIL per dimension');
  assert.match(t, /epics → stories → features → NFRs → rules/, 'verifies the full spec hierarchy');
  assert.match(t, /TAGGED with its\s+dimension/, 'each shortfall is tagged with its dimension');
  assert.match(t, /functionality \| ux \| code \| security \| docs/, 'names the dimension tags');
  assert.match(t, /CITE the/, 'findings cite real files');
});
