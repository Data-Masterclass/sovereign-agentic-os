/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       tabs/software
 * FEATURE:    THE GOLDEN PATH, END TO END — the whole app-building chain driven in process
 *             through the REAL dispatcher, as four principals, with a deployed cluster's config
 * USER STORY: As the product owner I want "the software app building truly working end to end":
 *             create → design → spec → build → verify → scan → request_deploy → decide_deploy →
 *             preview/serve → the app's SDK → lifecycle → git, each stage proving its GOVERNANCE
 *             (holds, refusals, separation of duties) and its ARTEFACTS (git paths + OS-* trailers,
 *             the served bundle), so a regression anywhere on the chain fails HERE and not live.
 * ARCHITECTURE:
 *   - THE REAL DISPATCHER. Every stage goes through `handleRpc(user, tools/call …)` — the exact
 *     JSON-RPC door the MCP HTTP route and the agent loop use, including its role floor and its
 *     bundle hydration — or, where the UI's door is an HTTP route a test may not import, through
 *     the SAME extracted service function that route calls. Nothing here re-implements a stage.
 *   - A DEPLOYED CLUSTER'S CONFIGURATION. `NODE_ENV=production` + `OS_OFFLINE_MOCK=refuse` are set
 *     BEFORE the first import, so the fail-closed paths are the ones under test: no fabricated
 *     rows, and a security scan with no engine is `unavailable` + `passed:false` rather than a
 *     green tick. The scan is another agent's module and is treated as a DEPENDENCY with its two
 *     declared shapes — `live` (injected) and `unavailable` (the cluster today).
 *   - FOUR PRINCIPALS, one app. creator (owns it), builder (approves another's deploy), and
 *     domain_admin / admin for the promotion rungs. Separation of duties is asserted in both
 *     directions: the owner cannot approve their own, and the approver cannot be the requester.
 *   - ORDER-DEPENDENT BY DESIGN. The stages share one app through the module-level `S`, in file
 *     order, because that IS the chain under test — stage 8 approves the card stage 7 filed, and
 *     stage 9 serves the spec stage 3 published. `node:test` runs top-level tests in declaration
 *     order, so this holds; it also means a failure early in the file will cascade, and the FIRST
 *     red stage is the one to read. Anything that does not belong to the single walk (the grant
 *     shapes, the agentic-builder cases, archive) creates its own app and is independent.
 *   - WHAT THIS FILE DELIBERATELY DOES NOT RE-ASSERT: the coded-apps platform gate (default OFF,
 *     fail-closed 403 from every door) is pinned four ways by `coded-apps-gate.test.ts`, which
 *     owns the one cross-tab import of `@tabs/admin/lib/settings` the ratchet has baselined. The
 *     suite harness turns coded apps ON, which is the environment the coded stages below need.
 *   - OFFLINE BUT NOT FAKE. `fetch` rejects, so the stores run in process; git is a REAL temp-dir
 *     repository (`config.reposDir`), so the commit shas, paths and OS-* trailers asserted below
 *     are the ones a cluster would write. The reasoning model is the ONE stubbed seam
 *     (`@core/runtime/complete`), deterministic, so the agentic builder and the spec generator are
 *     exercised rather than skipped.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';

// ── a deployed cluster's configuration, BEFORE the first import that reads it ────────────────
const _priorNodeEnv = process.env.NODE_ENV;
const _priorOfflineMock = process.env.OS_OFFLINE_MOCK;
(process.env as Record<string, string>).NODE_ENV = 'production';
process.env.OS_OFFLINE_MOCK = 'refuse';

// Offline: every OpenSearch/network fetch fails, so every store runs in process.
const _realFetch = globalThis.fetch;
globalThis.fetch = (() => Promise.reject(new Error('offline-stub'))) as typeof fetch;

/**
 * THE ONE STUBBED SEAM. The reasoning model. `generate_app_spec` and the agentic builder both
 * call `assistantComplete`; stubbing it deterministically is what lets this test drive those
 * stages for real instead of asserting around them. The reply is composed from the CURRENT
 * material each stage asks for, so it is a stand-in for the model, never a stand-in for the OS.
 */
let MODEL_REPLY: () => string = () => '{}';
const MODEL_CALLS: { system: string; user: string }[] = [];
mock.module('@core/runtime/complete', {
  namedExports: {
    assistantComplete: async (messages: { role: string; content: string }[]) => {
      MODEL_CALLS.push({
        system: messages.find((m) => m.role === 'system')?.content ?? '',
        user: messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n'),
      });
      return { content: MODEL_REPLY(), model: 'stub-reasoning' };
    },
  },
});

import type { CurrentUser } from '@core/kernel/auth';
import { testUser } from '@core/testing/user';
import { useGreenGates } from '@tabs/software/lib/test-gates';
useGreenGates();

const { handleRpc } = await import('@core/mcp/server');
const { config } = await import('@core/kernel/config');
const { __resetAppsCache, getAppByIdInternal, serveModeOf, setAppSpec, saveAppDraft, publishApp } =
  await import('./apps.ts');
const { __resetReviewCards, requestDeploy, decideDeploy, scanGate } = await import('./review.ts');
const { getSnapshot } = await import('./snapshot.ts');
const { VERSION_DELIM, REPORT_DELIM } = await import('./scan-trivy.ts');
const { securityScan } = await import('./scan.ts');
const { resolveServeTarget } = await import('./served-app.ts');
const { __setAppProjectGitForTests, appSubtreePrefix } = await import('./git-commit.ts');

// ── the four principals ──────────────────────────────────────────────────────────────────────
/** The CREATOR who owns the app. Full rights over their own work; approves nothing. */
const cara: CurrentUser = testUser({ id: 'cara', name: 'Cara', domains: ['sales'], role: 'creator' });
/** The BUILDER who approves SOMEBODY ELSE's deploy. */
const ben: CurrentUser = testUser({ id: 'ben', name: 'Ben', domains: ['sales'], role: 'builder' });
/** The DOMAIN_ADMIN who approves the My→Domain promotion rung. */
const dana: CurrentUser = testUser({ id: 'dana', name: 'Dana', domains: ['sales'], role: 'domain_admin' });
/** The ADMIN — the only role that certifies to Company. */
const alex: CurrentUser = testUser({ id: 'alex', name: 'Alex', domains: ['sales'], role: 'admin' });

let reposDir = '';
let priorRepos = '';
before(() => {
  reposDir = mkdtempSync(join(tmpdir(), 'os-repos-e2e-'));
  priorRepos = config.reposDir;
  (config as { reposDir: string }).reposDir = reposDir;
  __setAppProjectGitForTests(true);
  __resetAppsCache();
  __resetReviewCards();
});
after(() => {
  (config as { reposDir: string }).reposDir = priorRepos;
  __setAppProjectGitForTests(null);
  globalThis.fetch = _realFetch;
  if (_priorNodeEnv === undefined) delete process.env.NODE_ENV;
  else (process.env as Record<string, string>).NODE_ENV = _priorNodeEnv;
  if (_priorOfflineMock === undefined) delete process.env.OS_OFFLINE_MOCK;
  else process.env.OS_OFFLINE_MOCK = _priorOfflineMock;
  rmSync(reposDir, { recursive: true, force: true });
});

// ── the real dispatcher ──────────────────────────────────────────────────────────────────────

type Rpc = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

/** Call a governed MCP tool through `handleRpc` — the REAL door, role floor and all. */
async function rpc(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Rpc> {
  const res = await handleRpc(user, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.ok(res, `no response for ${name}`);
  return res as Rpc;
}

/** The tool's RESULT, asserting it did not error. */
async function callOk(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const res = await rpc(user, name, args);
  assert.equal(res.error, undefined, `${name} errored: ${JSON.stringify(res.error)}`);
  const result = res.result as { content?: { text?: string }[]; isError?: boolean; structuredContent?: unknown };
  assert.notEqual(result.isError, true, `${name} returned isError: ${JSON.stringify(result)}`);
  return unwrap(result);
}

/** The tool's ERROR, asserting it did not succeed. Returns the text an agent would read. */
async function callFails(user: CurrentUser, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = await rpc(user, name, args);
  if (res.error) return `${res.error.message} ${JSON.stringify(res.error.data ?? {})}`;
  const result = res.result as { isError?: boolean; content?: { text?: string }[] };
  assert.equal(result?.isError, true, `${name} unexpectedly SUCCEEDED: ${JSON.stringify(res.result)}`);
  return (result.content ?? []).map((c) => c.text ?? '').join('\n');
}

/** MCP tool results arrive as `content[0].text` JSON (+ `structuredContent`). Unwrap to an object. */
function unwrap(result: { content?: { text?: string }[]; structuredContent?: unknown }): Record<string, unknown> {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as Record<string, unknown>;
  }
  const text = (result.content ?? []).map((c) => c.text ?? '').join('');
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed };
  } catch {
    return { text };
  }
}

// ── the governed data the app is built over ──────────────────────────────────────────────────

/**
 * An "Orders" dataset with REAL documented columns, created through the GOVERNED `create_dataset`
 * MCP tool — the same door a user or an agent walks — rather than by reaching into the data tab's
 * store. That keeps the fixture honest (the columns the validator later checks are the columns
 * the governed write actually recorded) and keeps this file inside its own tab.
 */
async function seedOrders(name = 'Orders'): Promise<string> {
  const out = await callOk(cara, 'create_dataset', {
    name,
    domain: 'sales',
    columns: [
      { name: 'order_id', description: 'PK' },
      { name: 'net_amount', description: 'Money' },
      { name: 'status', description: 'State' },
    ],
  });
  const id = (out.id ?? (out.dataset as { id?: string } | undefined)?.id) as string | undefined;
  assert.ok(id, `create_dataset returned no id: ${JSON.stringify(out)}`);
  return id;
}

/** The app state shared across the ordered stages below. */
const S: { appId: string; slug: string; datasetId: string; cardId: string } = {
  appId: '',
  slug: '',
  datasetId: '',
  cardId: '',
};

const EPICS = [
  {
    id: 'epic_orders',
    title: 'Orders',
    stories: [
      {
        id: 'story_list',
        title: 'See open orders',
        asA: 'rep',
        iWant: 'a table of open orders',
        soThat: 'I can triage them',
        spec: { features: ['List every open order'], nfrs: ['Loads under a second'], rules: ['Read-only'] },
      },
    ],
  },
];

// ═══════════════════════ STAGE 1 · DEFINE ═══════════════════════

test('STAGE 1 · create_software — the creator defines a DECLARATIVE app by default', async () => {
  S.datasetId = await seedOrders();

  const app = await callOk(cara, 'create_software', {
    name: 'Orders desk',
    domain: 'sales',
    purpose: 'Triage and view orders',
  });
  assert.ok(typeof app.id === 'string' && app.id, 'an app id comes back');
  S.appId = app.id as string;
  S.slug = app.slug as string;

  const stored = await getAppByIdInternal(S.appId);
  assert.ok(stored);
  assert.equal(serveModeOf(stored), 'spec', 'DECLARATIVE is the default — no image pipeline');
  assert.equal(stored.owner, 'cara');
  assert.equal(stored.domain, 'sales');
  assert.equal(stored.visibility, 'Personal', 'a new app starts in the creator’s own lane');
});

// ═══════════════════════ STAGE 2 · DESIGN + CHOOSE CONTEXT ═══════════════════════

test('STAGE 2 · design_software — epics, per-story spec, and the dataset GRANT', async () => {
  const out = await callOk(cara, 'design_software', {
    appId: S.appId,
    purpose: 'Triage and view orders',
    epics: EPICS,
    grants: { data: [{ id: S.datasetId, access: 'read-only' }] },
  });
  assert.ok(out, 'the design write returns the patched app');

  const stored = await getAppByIdInternal(S.appId);
  assert.equal(stored?.epics?.length, 1);
  assert.equal(stored?.epics?.[0].stories.length, 1);
  assert.deepEqual(
    (stored?.grants?.data ?? []).map((g) => g.id),
    [S.datasetId],
    'the dataset is bound BY REFERENCE — the grant IS the authorisation',
  );
});

test('STAGE 2 · a grant with no `access` is GRANTED at the narrowest level, and SAID so', async () => {
  // THE FIX UNDER TEST (F10). `{ id }` without `access` — the shape a model writes from the
  // worked example — used to be dropped SILENTLY while the write still answered 200. The next
  // door then refused with "<id> is not granted to this app", sending the author back to the
  // grant door, which dropped it again: a loop with no error message anywhere in it.
  const app = await callOk(cara, 'create_software', { name: 'Grant shapes', domain: 'sales', purpose: 'p' });
  const out = await callOk(cara, 'design_software', {
    appId: app.id,
    grants: { data: [{ id: S.datasetId }], knowledge: [{ id: 'kn_x', access: 'nope' }] },
  });
  const stored = await getAppByIdInternal(app.id as string);
  assert.deepEqual(
    stored?.grants?.data,
    [{ id: S.datasetId, access: 'read-only' }],
    'an explicit grant is never silently ignored — it takes the NARROWEST level',
  );
  assert.deepEqual(stored?.grants?.knowledge, [], 'an access level that does not exist is still refused');
  const notes = (out.grantNotes ?? []) as string[];
  assert.ok(notes.some((n) => n.includes('read-only')), 'the default is reported');
  assert.ok(notes.some((n) => /nope/.test(n)), 'and so is the drop, naming what was wrong');
});

test('STAGE 2 · GOVERNANCE — a stranger can neither see nor design the app', async () => {
  const outsider = testUser({ id: 'otto', domains: ['ops'], role: 'builder' });
  const err = await callFails(outsider, 'design_software', { appId: S.appId, purpose: 'mine now' });
  assert.match(err, /not.?found/i, 'an app you cannot SEE is not_found — a write door never confirms an id a read door denies');
});

// ═══════════════════════ STAGE 3 · THE SPEC ═══════════════════════

/**
 * The spec a model actually writes. `source` is passed in so each case can use the CANONICAL
 * object or one of the two shorthands the reasoning model keeps emitting — a bare id string, or
 * a generic `{ id }`. `source` is a one-required-key reference slot, exactly like the `metric`
 * slot the owner's failure named, and it goes through the same normaliser rule.
 */
function specWithSource(source: unknown): Record<string, unknown> {
  return {
    version: 2,
    name: 'Orders desk',
    description: 'Triage and view orders',
    tabs: [
      {
        id: 'tab_orders',
        label: 'Orders',
        body: {
          kind: 'pattern',
          pattern: 'records-table',
          config: { source, columns: [{ field: 'order_id' }, { field: 'net_amount' }] },
        },
      },
    ],
  };
}

test('STAGE 3 · generate_app_spec — the scaffold runs the model and validates its reply', async () => {
  MODEL_REPLY = () => JSON.stringify(specWithSource({ datasetId: S.datasetId }));
  const out = await callOk(cara, 'generate_app_spec', { appId: S.appId });
  assert.equal(out.ok, true, `generate failed: ${JSON.stringify(out)}`);
  const spec = out.spec as { tabs: unknown[] };
  assert.equal(spec.tabs.length, 1, 'the generated spec carries the designed tab');
  assert.ok(MODEL_CALLS.length > 0, 'the reasoning model really was asked');
  assert.match(
    MODEL_CALLS[MODEL_CALLS.length - 1].user,
    new RegExp(S.datasetId),
    'the prompt is GROUNDED in the granted dataset, so the model cannot invent one',
  );
});

test('STAGE 3 · generate_app_spec TOLERATES the shape the model keeps writing, and SAYS so', async () => {
  // The owner's stage-4 failure in its general form: a bare id string where the grammar wants
  // the canonical one-key object. The exact `metric must be an object / use { metricId }` case
  // the owner hit is pinned per-door in `set-app-spec.test.ts`, which already owns the data-tab
  // fixture import this file deliberately does without.
  MODEL_REPLY = () => JSON.stringify(specWithSource(S.datasetId));
  const out = await callOk(cara, 'generate_app_spec', { appId: S.appId });
  assert.equal(out.ok, true, `a bare metric id must not kill the build: ${JSON.stringify(out)}`);
  const notes = (out.notes ?? []) as string[];
  assert.ok(
    notes.some((n) => /normalised source id/i.test(n)),
    'the rewrite is REPORTED, never silent',
  );
});

test('STAGE 3 · set_app_spec — authoring a bare metric id must NOT be the owner’s dead end', async () => {
  // THE FIX UNDER TEST (F1). `set_app_spec` is the documented hand-authoring door and the one an
  // agent reaches for after reviewing a generated spec. It used to call `parseAppSpec` directly,
  // so the tolerant normaliser protected `generate_app_spec` and NOTHING else.
  const out = await callOk(cara, 'set_app_spec', { appId: S.appId, spec: specWithSource(S.datasetId) });
  assert.equal(out.ok, true, `set_app_spec rejected a readable spec: ${JSON.stringify(out)}`);
  const warnings = (out.warnings ?? []) as { reason?: string }[];
  assert.ok(
    warnings.some((w) => /normalised source id/i.test(w.reason ?? '')),
    'the author is TOLD what was tidied up — a coercion is never invisible',
  );
  assert.equal(out.servedUrl, `/apps/${S.slug}`, 'author = publish: it names where the app is now live');
});

test('STAGE 3 · set_app_spec — the `{ id }` rename is tolerated too, and the stored spec is CANONICAL', async () => {
  const out = await callOk(cara, 'set_app_spec', { appId: S.appId, spec: specWithSource({ id: S.datasetId }) });
  assert.equal(out.ok, true, `the { id } shape must be read: ${JSON.stringify(out)}`);
  const stored = await getAppByIdInternal(S.appId);
  const tab = stored?.spec?.tabs?.[0] as { body: { config: { source: unknown } } };
  assert.deepEqual(
    tab.body.config.source,
    { datasetId: S.datasetId },
    'TOLERANT PARSE, STRICT OUTPUT — what persists is always the canonical shape',
  );
});

test('STAGE 3 · the OTHER two spec doors normalise identically (draft autosave + publish)', async () => {
  // `saveAppDraft` and `publishApp` are the composer's doors; they re-parse the same bytes.
  await saveAppDraft(S.appId, specWithSource(S.datasetId), cara);
  const published = await publishApp(S.appId, cara);
  assert.deepEqual(published.issues, [], `publish rejected a readable draft: ${JSON.stringify(published.issues)}`);
  const tab = published.app.spec?.tabs?.[0] as { body: { config: { source: unknown } } };
  assert.deepEqual(tab.body.config.source, { datasetId: S.datasetId });
});

test('STAGE 3 · GOVERNANCE — what is genuinely wrong is still REFUSED, and persists nothing', async () => {
  const before = (await getAppByIdInternal(S.appId))?.spec;
  const out = await callOk(cara, 'set_app_spec', {
    appId: S.appId,
    spec: {
      version: 2,
      name: 'Orders desk',
      description: 'x',
      tabs: [
        {
          id: 'tab_bad',
          label: 'Bad',
          body: {
            kind: 'pattern',
            pattern: 'records-table',
            config: { source: { datasetId: S.datasetId }, columns: [{ field: 'ghost_column' }] },
          },
        },
      ],
    },
  });
  assert.equal(out.ok, false, 'an invented column is a BLOCKING issue');
  const issues = out.issues as { reason: string; fix: string }[];
  assert.ok(issues.length > 0 && issues.every((i) => i.reason && i.fix), 'every issue is machine-actionable { path, reason, fix }');
  assert.deepEqual((await getAppByIdInternal(S.appId))?.spec, before, 'a rejected author persists NOTHING');
});

test('STAGE 3 · GOVERNANCE — an ungranted dataset cannot be authored in', async () => {
  const ungranted = await seedOrders('Other orders'); // real — but NOT granted to this app
  const out = await callOk(cara, 'set_app_spec', {
    appId: S.appId,
    spec: {
      version: 2,
      name: 'Orders desk',
      description: 'x',
      tabs: [
        {
          id: 'tab_ungranted',
          label: 'Ungranted',
          body: {
            kind: 'pattern',
            pattern: 'records-table',
            config: { source: { datasetId: ungranted }, columns: [{ field: 'order_id' }] },
          },
        },
      ],
    },
  });
  assert.equal(out.ok, false, 'the GRANT is the authorisation — an ungranted source is refused at author time');
});

// ═══════════════════════ STAGE 4 · BUILD ═══════════════════════

test('STAGE 4 · build_software on a DECLARATIVE app routes to the declarative verbs, not a 403', async () => {
  // THE FIX UNDER TEST (F2). `build_software` used to hand EVERY app the coded directive —
  // "author the code, then call `commit`" — and `commit` then answers 403 because coded apps are
  // off by default. The DEFAULT app kind therefore had no stage-4 verb at all.
  const out = await callOk(cara, 'build_software', { appId: S.appId });
  const directive = String(out.directive ?? '');
  const next = String(out.next ?? '');
  assert.equal(out.kind, 'spec', 'the tool says which of the two paths this app is on');
  // It may SAY there is nothing to commit; it must never INSTRUCT a commit, nor a source tree.
  assert.doesNotMatch(directive + next, /(call|then) `commit`/, 'a declarative app is never told to call `commit`');
  assert.doesNotMatch(directive + next, /src\/epics/, 'a declarative app has no source tree to write into');
  assert.match(next, /set_app_spec|generate_app_spec/, 'it names the verb that actually authors this app');
  assert.match(directive, new RegExp(S.datasetId), 'the granted context is still injected');
  assert.equal(out.code, undefined, 'and it does not hand back a template scaffold as "the code"');
});

test('STAGE 4 · GOVERNANCE — the design-before-build gate still refuses an unspecced story', async () => {
  const bare = await callOk(cara, 'create_software', { name: 'Unspecced', domain: 'sales', purpose: 'p' });
  await callOk(cara, 'design_software', {
    appId: bare.id,
    epics: [{ id: 'e1', title: 'E', stories: [{ id: 's1', title: 'S', asA: 'a', iWant: 'b', soThat: 'c' }] }],
  });
  const err = await callFails(cara, 'build_software', { appId: bare.id });
  assert.match(err, /design/i, 'the gate names what to design first');
});

// ═══════════════════════ STAGE 5 · VERIFY ═══════════════════════

test('STAGE 5 · verify_software on a DECLARATIVE app verifies the SPEC, not absent code', async () => {
  const out = await callOk(cara, 'verify_software', { appId: S.appId });
  assert.equal(out.kind, 'spec', 'kind-aware, like build');
  const directive = String(out.directive ?? '');
  assert.doesNotMatch(directive, /read the COMMITTED code/i, 'there is no committed code to read');
  assert.ok(out.spec !== undefined || out.describe !== undefined, 'it hands back the real artefact under test');
});

// ═══════════════════════ STAGE 6 · THE SCAN (a dependency: live | unavailable) ═══════════════

test('STAGE 6 · the scan on a cluster with no engine yields NO verdict — and the gate closes', () => {
  const r = securityScan([{ path: 'x.ts', content: 'export const a = 1;\n' }]);
  assert.equal(r.unavailable, true, 'under NODE_ENV=production with no engine the scan is `unavailable`');
  assert.equal(r.passed, false, 'a clean tree is NOT a passed scan when nothing scanned it');
  assert.match(r.reason ?? '', /scan/i, 'it says WHY there is no verdict');
});

test('STAGE 6 · the scan catches a real secret when an engine IS available', () => {
  const r = securityScan([{ path: 'aws.ts', content: 'const k = "AKIAIOSFODNN7EXAMPLE";\n' }], 'offline-mock');
  assert.equal(r.passed, false, 'a committed access key blocks');
  assert.ok(r.findings.length > 0, 'and the finding is reported, not just the verdict');
});

// ═══════════════════════ STAGE 7–8 · REQUEST AND DECIDE ═══════════════════════

test('STAGE 7 · request_deploy opens the review gate — the MCP cannot self-deploy', async () => {
  // Driven through the service fn with an INJECTED live scanner, which is the shape the cluster
  // gets once a scanner exists; the `unavailable` shape is stage 6 above and is asserted to
  // block at decide time below.
  const res = await requestDeploy(S.appId, cara, { scanMode: 'offline-mock' });
  assert.equal(res.kind, 'review', 'a first deploy ALWAYS opens a card — never an auto-deploy');
  S.cardId = res.kind === 'review' ? res.card.id : '';
  assert.ok(S.cardId);
  assert.equal(res.kind === 'review' ? res.card.requestedBy : '', 'cara');
});

test('STAGE 8 · SEPARATION OF DUTIES — the owner cannot approve their own deploy', async () => {
  const err = await callFails(cara, 'decide_deploy', { cardId: S.cardId, decision: 'approve' });
  assert.ok(err, 'a creator has no `decide_deploy` at all — the role floor is builder');
  const card = (await import('./review.ts')).getReviewCard;
  assert.equal((await card(S.cardId))?.decision, 'pending', 'and the card is untouched');
});

test('STAGE 8 · SEPARATION OF DUTIES — a BUILDER who is not the requester approves it', async () => {
  const out = await callOk(ben, 'decide_deploy', { cardId: S.cardId, decision: 'approve' });
  const app = out.app as { deploy: { state: string } };
  assert.equal(app.deploy.state, 'live', 'the second pair of eyes is what makes it live');
  const card = await (await import('./review.ts')).getReviewCard(S.cardId);
  assert.equal(card?.decision, 'approved');
  assert.equal(card?.decidedBy, 'ben', 'the approver is recorded by id, and is NOT the requester');
});

test('STAGE 8 · a scan with NO verdict cannot be approved by anyone — not even a builder', async () => {
  const fresh = await callOk(cara, 'create_software', { name: 'No scanner', domain: 'sales', purpose: 'p' });
  const res = await requestDeploy(fresh.id as string, cara); // no injected mode ⇒ `unavailable`
  assert.equal(res.kind, 'review');
  const cardId = res.kind === 'review' ? res.card.id : '';
  await assert.rejects(
    () => decideDeploy(cardId, ben, 'approve'),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 409);
      assert.match(e.message, /no security verdict|did not pass/i, 'it refuses HONESTLY, naming the absence');
      return true;
    },
  );
});

// ═══════════════════════ STAGE 9 · SERVE ═══════════════════════

test('STAGE 9 · the declarative app resolves to the SAME-ORIGIN spec renderer', async () => {
  const app = await getAppByIdInternal(S.appId);
  assert.ok(app);
  const target = resolveServeTarget(app);
  assert.equal(target.kind, 'spec', 'served by the trusted OS renderer at /apps/<slug> — no image, no pod');
  assert.ok(app.spec, 'and there is a validated spec to render');
});

test('STAGE 9 · an `image` app with NO image fails CLOSED and loudly — never a stranger’s container', async () => {
  const app = await getAppByIdInternal(S.appId);
  assert.ok(app);
  const asImage = { ...app, serveMode: 'image' as const, spec: undefined };
  const target = resolveServeTarget(asImage);
  assert.notEqual(target.kind, 'spec');
  assert.doesNotMatch(JSON.stringify(target), /whoami/, 'no placeholder container is ever substituted');
});

// ═══════════════════════ STAGE 10 · THE APP'S SDK ═══════════════════════

test('STAGE 10 · the SDK is same-origin and carries NO credential of its own', async () => {
  const { createOsClient } = await import('@core/app-sdk/index');
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ id: 'cara', role: 'creator', domains: ['sales'] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const os = createOsClient({ fetch: fetchImpl, appSlug: S.slug });
  const me = await os.whoami();
  assert.equal(me.id, 'cara', 'the app sees the SIGNED-IN user, resolved by the OS');
  assert.equal(calls[0].url, '/api/auth/me', "the OS UI's own identity door, verbatim");
  assert.equal(calls[0].init.credentials, 'include', 'the AMBIENT session is the identity');
  const { carriesOwnCredential } = await import('./app-agents.ts');
  const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
  assert.equal(carriesOwnCredential({ headers, body: {} }), false, 'an app never presents a key of its own');
});

test('STAGE 10 · a record written through the governed door is stamped with the WRITING user', async () => {
  const { addAppRecord, listAppRecords, __resetAppRecordsCache } = await import('./app-records-store.ts');
  const { recordActor } = await import('./app-records.ts');
  __resetAppRecordsCache();

  const written = await addAppRecord({
    appSlug: S.slug,
    owner: cara.id,
    domain: 'sales',
    record: { order_id: 'o-1', net_amount: 42 },
  });
  assert.equal(written.owner, 'cara', 'the row carries the USER — never an app or service principal');

  const mine = await listAppRecords({ appSlug: S.slug, actor: recordActor(cara) });
  assert.equal(mine.length, 1, 'the writer reads their own row back');

  // Two sessions, same app, DIFFERENT row sets.
  const stranger = testUser({ id: 'otto', domains: ['ops'], role: 'creator' });
  const theirs = await listAppRecords({ appSlug: S.slug, actor: recordActor(stranger) });
  assert.equal(theirs.length, 0, 'a user in another domain sees NOTHING from the same app');
});

test('STAGE 10 · the DECLARATION is the boundary — a scope the app never declared is refused', async () => {
  const { parseAppActions, withinDeclaredScopes, ACTIONS_FILE } = await import('./app-actions.ts');
  const { actions, issues } = parseAppActions([
    {
      path: ACTIONS_FILE,
      content: [
        'actions:',
        '  - name: list_orders',
        '    description: List the orders the caller may see.',
        '    write: false',
        '    scopes: [records]',
        '    input:',
        '      status: string',
      ].join('\n'),
    },
  ]);
  assert.deepEqual(issues, [], 'a well-formed declaration parses clean');
  assert.equal(actions.length, 1);
  assert.equal(actions[0].write, false, 'and a read declares itself a read');
  assert.equal(withinDeclaredScopes(actions[0], ['records']), true, 'a declared scope is in scope');
  assert.equal(
    withinDeclaredScopes(actions[0], ['records', 'data']),
    false,
    'a scope the app never declared is NOT in scope, even alongside one it did',
  );
});

test('STAGE 10 · a malformed declaration comes BACK as an issue, never silently dropped', async () => {
  const { parseAppActions, ACTIONS_FILE } = await import('./app-actions.ts');
  const { actions, issues } = parseAppActions([
    { path: ACTIONS_FILE, content: ['actions:', '  - name: Not A Name', '    scopes: [records]'].join('\n') },
  ]);
  assert.equal(actions.length, 0, 'an invalid action is not registered');
  assert.ok(issues.length > 0 && issues[0].fix, 'and the author is told what is wrong and how to fix it');
});

// ═══════════════════════ STAGE 4b · THE AGENTIC BUILDER HARNESS (stream H) ═══════════════

test('STAGE 4b · the agentic harness: the SCORECARD is the gate, and a reviewer cannot override it', async () => {
  // Driven through `agenticBuild` with the `build` dep (the compile gate) injected, because the
  // real gate runs tsc + esbuild-wasm and this suite runs beside three others — the gate has its
  // own tests, and `builder/dispatch.test.ts` pins that `SOFTWARE_BUILDER=agentic` routes here.
  // Everything else is real: the acceptance derivation, the bounded loop and the governed commit.
  //
  // THE CASE: a page that compiles but never reaches governed data. The reviewer is scripted to
  // say `pass`. It must NOT ship — "it compiled" is not "it satisfies the story".
  {
    const created = await callOk(cara, 'create_software', {
      name: 'Agentic hollow', domain: 'sales', purpose: 'Triage orders', kind: 'code',
    });
    await callOk(cara, 'design_software', { appId: created.id, epics: EPICS });
    const app = await getAppByIdInternal(created.id as string);
    assert.ok(app);

    const { agenticBuild } = await import('./builder/loop-server.ts');
    const HOLLOW = 'export default function Orders() { return null; }\n';
    const out = await agenticBuild(cara, app, { kind: 'app' }, {
      deps: {
        plan: async () => 'Render the open orders table.',
        code: async () => ({ files: [{ path: 'src/epics/epic_orders/story_list/Page.tsx', content: HOLLOW }], text: 'wrote the page' }),
        build: async () => ({ gated: true, ok: true, errors: [], text: 'compiled' }),
        review: async () => ({ verdict: 'pass' as const, notes: ['looks good to me'] }),
      },
    });

    assert.equal(out.committed, null, 'a tree that does not reach governed data is NOT committed');
    assert.equal(out.acceptanceFile, null, 'and no scorecard is filed for a build that did not happen');
    assert.match(out.summary, /Nothing was committed/i, 'and it SAYS nothing shipped');
    assert.match(out.next, /Nothing is done yet/i, 'never "done" over an unmet scorecard');
    assert.equal(out.acceptance.failed > 0, true, 'the failing check is the reason, and it is reported');
    assert.match(out.acceptance.report, /static check \(AST\)/, 'the static check SAYS it is static');
  }
});

test('STAGE 4b · the agentic harness commits a real tree AND an HONEST `.app/acceptance.json`', async () => {
  {
    const created = await callOk(cara, 'create_software', {
      name: 'Agentic real', domain: 'sales', purpose: 'Triage orders', kind: 'code',
    });
    await callOk(cara, 'design_software', { appId: created.id, epics: EPICS });
    const app = await getAppByIdInternal(created.id as string);
    assert.ok(app);

    const { agenticBuild } = await import('./builder/loop-server.ts');
    // A page that actually reaches governed data through the SDK — what the story asked for.
    // Synchronous on purpose: the template auto-registers a story page as a `ComponentType`, so
    // an async component is a REAL compile error the governed commit door refuses — which is how
    // this fixture was first written, and the gate caught it.
    const REAL = [
      "import { createOsClient } from '@sovereign-os/app-sdk';",
      'const os = createOsClient();',
      'export default function Orders() {',
      '  const load = () => os.records.list();',
      '  void load;',
      '  return null;',
      '}',
      '',
    ].join('\n');
    const out = await agenticBuild(cara, app, { kind: 'app' }, {
      deps: {
        plan: async () => 'Render the open orders table from os.records.',
        code: async () => ({ files: [{ path: 'src/epics/epic_orders/story_list/Page.tsx', content: REAL }], text: 'wrote the page' }),
        build: async () => ({ gated: true, ok: true, errors: [], text: 'compiled' }),
        review: async () => ({ verdict: 'pass' as const, notes: [] }),
      },
    });

    assert.ok(out.committed, 'the tree went through the GOVERNED commit door, not straight to disk');
    assert.equal(out.acceptanceFile, '.app/acceptance.json', 'the scorecard rides the SAME commit as the code');
    assert.equal(out.acceptance.failed, 0, 'every automatable check is met');

    // AND THE SCORECARD IS HONEST — the whole point of the file.
    assert.ok(out.acceptance.manual > 0, 'NFRs and business rules are left to a human, not decided');
    assert.match(out.acceptance.report, /for a human to confirm/, 'and it says WHO decides those');
    for (const line of out.acceptance.report.split('\n')) {
      if (line.startsWith('MANUAL')) assert.doesNotMatch(line, /\bPASS\b/, 'a MANUAL check is never a pass');
    }

    // `read_app_files` is the ONE reader that exists — pinning the claim the header now makes.
    const read = await callOk(cara, 'read_app_files', { appId: created.id, path: '.app/acceptance.json' });
    const raw = JSON.stringify(read);
    assert.match(raw, /acceptance-passed|acceptance-incomplete/, 'the committed record round-trips');
    assert.match(raw, /agentic/, 'and names which builder produced it');
  }
});

// ═══════════════════════ STAGE 11 · LIFECYCLE AND THE PROMOTION RUNGS ═══════════════════════

test('STAGE 11 · the promotion ladder — a creator FILES, the domain_admin APPROVES', async () => {
  // Over the MCP, `promote` is an ELEVATED tool with a builder floor, so a creator cannot
  // reach it at all — which is the ladder's own rule: a creator files and hands off.
  const refused = await callFails(cara, 'promote', { appId: S.appId });
  assert.ok(refused, 'a creator has no `promote` — the rung belongs to someone else');

  // The owner FILES the My→Domain request through the ladder seam the UI route uses.
  const { promoteOrRequest } = await import('@core/policy/ladder');
  const filed = await promoteOrRequest('app', S.appId, cara);
  assert.equal(filed.requested, true, 'a creator-owned Personal app is FILED, never self-promoted');

  // The domain_admin acts as the APPROVE half — and only now can they even see it.
  const approved = await callOk(dana, 'promote', { appId: S.appId });
  assert.ok(approved, 'the domain_admin approves the My→Domain rung');
  const afterDomain = await getAppByIdInternal(S.appId);
  assert.notEqual(afterDomain?.visibility, 'Personal', 'the app left the creator’s own lane');
});

test('STAGE 11 · SEPARATION OF DUTIES — only the admin certifies to Company', async () => {
  const before = (await getAppByIdInternal(S.appId))?.visibility;
  const notAdmin = await callFails(dana, 'promote', { appId: S.appId });
  assert.ok(notAdmin, 'a domain_admin cannot certify to Company');
  assert.equal((await getAppByIdInternal(S.appId))?.visibility, before, 'and the refusal changed nothing');
  const certified = await callOk(alex, 'promote', { appId: S.appId });
  assert.ok(certified, 'only the admin certifies');
});

test('STAGE 11 · archive is reversible and an archived app refuses every write', async () => {
  const app = await callOk(cara, 'create_software', { name: 'Retire me', domain: 'sales', purpose: 'p' });
  await callOk(cara, 'archive', { appId: app.id });
  const stored = await getAppByIdInternal(app.id as string);
  assert.equal(stored?.status, 'archived');
  await assert.rejects(
    () => setAppSpec(app.id as string, { version: 2, name: 'x', description: 'x', tabs: [] }, cara),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 409, 'an archived app is a 409 on every write, not a silent no-op');
      return true;
    },
  );
});

// ═══════════════════════ STAGE 12 · GIT ═══════════════════════

test('STAGE 12 · push_app_files commits under apps/<slug>/ with the OS-* trailers, as the USER', async () => {
  {
    const coded = await callOk(cara, 'create_software', {
      name: 'Coded orders',
      domain: 'sales',
      purpose: 'p',
      kind: 'code',
    });
    const codedSlug = coded.slug as string;
    const files = [{ path: 'src/App.tsx', content: 'export default function App() { return null; }\n' }];

    const out = await callOk(cara, 'push_app_files', { appId: coded.id, files, message: 'first push' });
    assert.equal(out.changed, true, 'the first push changes the tree');
    // UNGUARDED on purpose: `config.reposDir` is a real temp directory and app-project git is
    // forced on for this suite, so a null commit means the governed write FAILED and the trailer
    // assertions below must not be skipped into a false pass.
    const commit = out.commit as string | null;
    assert.ok(commit, `the governed commit produced no sha: ${JSON.stringify(out)}`);

    const { log } = await import('@core/infra/git-store');
    const entries = await log('sales', { path: appSubtreePrefix(codedSlug) });
    assert.ok(entries.length > 0, 'the commit is path-scoped under apps/<slug>/');
    const head = entries[0];
    assert.equal(head.author.email?.includes('cara') || head.author.name?.includes('ara'), true,
      'the AUTHOR is the acting user — not a service principal');
    assert.match(head.message, /OS-Action:/, 'OS-Action trailer');
    assert.match(head.message, /OS-Object: app:/, 'OS-Object names the app');
    assert.match(head.message, /OS-Surface:/, 'OS-Surface names the door');
    assert.match(head.message, /OS-Request-Id:/, 'OS-Request-Id ties it to the request');

    // S-R1.4: pushing the SAME bytes twice yields ONE commit.
    const again = await callOk(cara, 'push_app_files', { appId: coded.id, files, message: 'same bytes' });
    assert.equal(again.changed, false, 'an unchanged push creates NO second commit');

    // The round trip: what was pushed is what reads back.
    const read = await callOk(cara, 'read_app_files', { appId: coded.id, path: 'src/App.tsx' });
    assert.match(JSON.stringify(read), /export default function App/, 'push → read round-trips the real bytes');
  }
});

// ── STAGE 13: the lockfile ───────────────────────────────────────────────────────────────────
// A cluster whose scan Job succeeds and whose pod prints the given Trivy report — the same
// injected-engine shape `review-no-scan-hatch.test.ts` uses. No Trivy binary runs in this suite;
// the report is what Trivy v0.58.2 returns for a tree whose one lockfile resolves packages (one
// `lang-pkgs` result, `Target` = the lockfile path), and it is the SAME report before and after
// the manifest edit below, because Trivy reads the lockfile and never the manifest.
function liveScanReturning(report: string) {
  const uid = 'job-uid-e2e-lock';
  const k8s = async (method: string, path: string) => {
    if (method === 'POST') return { status: 201, body: { metadata: { uid } } };
    if (method === 'DELETE') return { status: 200, body: {} };
    if (path.includes('/pods?')) {
      return { status: 200, body: { items: [{ metadata: { name: 'scan-pod', ownerReferences: [{ uid }] } }] } };
    }
    if (path.includes('/jobs/')) return { status: 200, body: { metadata: { uid }, status: { succeeded: 1 } } };
    return { status: 404, body: {} };
  };
  const k8sText = async () => ({ status: 200, text: `${VERSION_DELIM}\n{}\n${REPORT_DELIM}\n${report}\n` });
  return {
    scannerEnabled: true as const,
    trivy: {
      k8s,
      k8sText,
      namespace: 'agentic-os',
      image: 'aquasec/trivy:0.58.2',
      dbMode: 'mirror' as const,
      dbRepository: 'ghcr.io/aquasecurity/trivy-db',
      timeoutMs: 5_000,
      runId: 'e2elock01',
      sleep: async () => {},
    },
  };
}

test('STAGE 13 · a freshly scaffolded CODED app ships a REAL lockfile, so the engine covers its dependencies', async () => {
  const coded = await callOk(cara, 'create_software', { name: 'Locked orders', domain: 'sales', purpose: 'p', kind: 'code' });
  const appId = coded.id as string;
  const tree = getSnapshot(appId) ?? [];
  const manifest = JSON.parse(tree.find((f) => f.path === 'package.json')!.content) as {
    name: string;
    dependencies: Record<string, string>;
  };
  const lock = JSON.parse(tree.find((f) => f.path === 'package-lock.json')!.content) as {
    name: string;
    packages: Record<string, { name?: string; dependencies?: Record<string, string>; version?: string }>;
  };
  assert.equal(lock.name, coded.slug, 'the lockfile is the app’s own — it carries the app’s slug');
  assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies, 'and its root entry IS this manifest');
  assert.ok(lock.packages['node_modules/react']?.version, 'with a real resolution behind each dependency');
  assert.ok(tree.some((f) => f.path === 'vendor/@sovereign-os/ui/package.json'), 'the file: dependencies it names are in the tree');

  const resolved = JSON.stringify({ SchemaVersion: 2, Results: [{ Target: 'package-lock.json', Class: 'lang-pkgs', Type: 'npm' }] });
  const first = await requestDeploy(appId, cara, { scan: liveScanReturning(resolved) });
  assert.equal(first.kind, 'review');
  if (first.kind !== 'review') return;
  assert.equal(first.card.scan.mode, 'live', 'the engine ran');
  assert.deepEqual(first.card.scan.notRun, ['sast'], `deps must be COVERED on a fresh scaffold: ${first.card.scan.reason ?? ''}`);
  assert.equal(first.card.scan.passed, true, 'no acknowledgement is needed for a freshly generated app any more');
  assert.equal(scanGate(first.card.scan).kind, 'passed');

  // STALENESS: the owner pushes a changed manifest and no new lockfile. The engine would report
  // exactly what it reported a moment ago — and that must no longer count as dependency coverage.
  manifest.dependencies['date-fns'] = '^3.6.0';
  await callOk(cara, 'push_app_files', {
    appId,
    files: [{ path: 'package.json', content: JSON.stringify(manifest, null, 2) + '\n' }],
    message: 'add a dependency, forget the lockfile',
  });
  const second = await requestDeploy(appId, cara, { scan: liveScanReturning(resolved) });
  assert.equal(second.kind, 'review');
  if (second.kind !== 'review') return;
  assert.equal(second.card.scan.passed, false);
  assert.ok(second.card.scan.notRun?.includes('deps'), 'a stale lockfile is NOT coverage');
  assert.deepEqual(scanGate(second.card.scan), { kind: 'uncovered', categories: ['deps'] });
  assert.match(second.card.scan.reason ?? '', /date-fns/, 'the difference is named');
  assert.match(second.card.scan.reason ?? '', /npm install --package-lock-only/, 'and so is the remedy');
});
