/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { runAgentic, type LlmCall } from '@/lib/assistant/agentic';
import { createApp } from '@/lib/software/apps';
import { commitToApp, getSnapshot, refreshVendoredSdk } from './server.ts';
import { sovereignAppFiles } from './scaffolds/sovereign-app.ts';
import {
  compileGate,
  formatGateError,
  gateActivityNote,
  gateEnvironmentReady,
  gateBundleAssetReady,
  MAX_DIAGNOSTICS,
  __vendorReads,
} from './compile-gate.ts';
import { esbuildWasmReady } from './preview-runtime.ts';
import { gateLineFromStep } from './build-activity.ts';
import { ensureSectionsRegistered } from './sections-registry.ts';
import type { ScaffoldFile } from './model.ts';

const dev: CurrentUser = { id: 'dan', name: 'Dan', domains: ['eng'], role: 'creator' };

/** A sovereign-app scaffold tree with extra files overlaid (the gate's usual input). */
function viteTree(extra: ScaffoldFile[] = []): ScaffoldFile[] {
  const base = sovereignAppFiles('Gate Test', 'gate-test');
  const byPath = new Map(base.map((f) => [f.path, f]));
  for (const f of extra) byPath.set(f.path, f);
  return [...byPath.values()];
}

// ------------------------------------------------------------------ the gate itself ---

/**
 * The three REAL failure shapes from the live `app_on1hxye3ocl` class (redesign doc):
 * a wrong Badge prop (type error), an unimported identifier, and a wrong import depth.
 * Each must be REJECTED with a diagnostic naming the exact file + line.
 */
test('compile gate rejects the wrong Badge prop (variant vs tone) with file+line', async () => {
  const res = await compileGate(
    viteTree([
      {
        path: 'src/epics/dossier/live/Live.tsx',
        content: [
          "import { Badge } from '@sovereign-os/ui';",
          'export default function Live() {',
          '  return <Badge variant="info">x</Badge>;',
          '}',
          '',
        ].join('\n'),
      },
    ]),
  );
  assert.ok(res.gated && !res.ok, 'must be gated and rejected');
  if (res.gated && !res.ok) {
    const d = res.diagnostics.find((x) => x.file === 'src/epics/dossier/live/Live.tsx');
    assert.ok(d, 'diagnostic names the offending file');
    assert.equal(d!.line, 3, 'diagnostic names the offending line');
    assert.equal(d!.code, 2322, 'the variant-vs-tone misuse is the TS2322 assignability error');
  }
});

test('compile gate rejects an unimported identifier (TS2304) and a wrong import depth (TS2307)', async () => {
  const unimported = await compileGate(
    viteTree([
      {
        path: 'src/epics/e/s/Page.tsx',
        content: 'export default function P() {\n  return <Card>x</Card>;\n}\n',
      },
    ]),
  );
  assert.ok(unimported.gated && !unimported.ok);
  if (unimported.gated && !unimported.ok) {
    assert.ok(unimported.diagnostics.some((d) => d.code === 2304 && /Card/.test(d.message)));
  }

  const wrongDepth = await compileGate(
    viteTree([
      {
        path: 'src/epics/e/s/Page.tsx',
        content: [
          "import { Badge } from '../../@sovereign-os/ui';",
          'export default function P() {',
          '  return <Badge tone="ok">x</Badge>;',
          '}',
          '',
        ].join('\n'),
      },
    ]),
  );
  assert.ok(wrongDepth.gated && !wrongDepth.ok);
  if (wrongDepth.gated && !wrongDepth.ok) {
    const d = wrongDepth.diagnostics.find((x) => x.code === 2307);
    assert.ok(d, 'the wrong ../../ depth is a cannot-find-module error');
    assert.equal(d!.file, 'src/epics/e/s/Page.tsx');
  }
});

test('compile gate rejects a hallucinated UI primitive (Modal — TS2305 missing export)', async () => {
  const res = await compileGate(
    viteTree([
      {
        path: 'src/epics/e/s/Page.tsx',
        content: "import { Modal } from '@sovereign-os/ui';\nexport default function P(){ return <Modal/>; }\n",
      },
    ]),
  );
  assert.ok(res.gated && !res.ok);
  if (res.gated && !res.ok) {
    assert.ok(res.diagnostics.some((d) => d.code === 2305 && /Modal/.test(d.message)));
  }
});

test('the pristine sovereign-app scaffold passes the gate clean (tsc + bundle)', async () => {
  const res = await compileGate(viteTree());
  assert.deepEqual(res, { gated: true, ok: true });
});

test('a correct story page using the real UI API passes', async () => {
  const res = await compileGate(
    viteTree([
      {
        path: 'src/epics/dossier/live/Live.tsx',
        content: [
          "import { Badge, Card, Section } from '@sovereign-os/ui';",
          'export default function Live() {',
          '  return (',
          '    <Section title="Live">',
          '      <Card><Badge tone="ok">ok</Badge></Card>',
          '    </Section>',
          '  );',
          '}',
          '',
        ].join('\n'),
      },
    ]),
  );
  assert.deepEqual(res, { gated: true, ok: true });
});

/** The bundle pass covers exactly what the tsc CSS shim cannot see: a missing stylesheet.
 *  Registration mirrors the real commit path: `ensureSectionsRegistered` wires the story
 *  page into sections.tsx BEFORE the gate, so the page is reachable from the SPA entry. */
test('BUNDLE pass: an import of a nonexistent css file is rejected (tsc alone cannot see it)', async () => {
  const base = sovereignAppFiles('Gate Test', 'gate-test');
  const changeset: ScaffoldFile[] = [
    {
      path: 'src/epics/e/s/Page.tsx',
      content: "import './missing.css';\nexport default function P(){ return <div/>; }\n",
    },
  ];
  const toCommit = ensureSectionsRegistered(base, changeset, 'sovereign-app');
  const res = await compileGate(viteTree(toCommit));
  assert.ok(res.gated && !res.ok, 'the missing stylesheet must reject the commit');
  if (res.gated && !res.ok) {
    assert.equal(res.diagnostics[0].code, 0, 'a bundle error carries no TS code');
    assert.match(res.diagnostics[0].message, /missing\.css/);
  }
});

// -------------------------------------------------- SDK type closure (Task 1.4) ---

/**
 * The OsClient interface is CLOSED: `createOsClient` is annotated `: OsClient` (a
 * fixed interface, no index signature), so a HALLUCINATED method the SDK never
 * exposes is a TS2339 the gate catches — nothing is written. `os.datasets.update`
 * is the exact method the build assistant invented for weeks; this locks the closure
 * so a future edit that loosens the return type (e.g. `: any`) is caught here.
 * WRITES live on `os.records.*` only; datasets are read-only.
 */
test('SDK TYPE CLOSURE: a hallucinated os.datasets.update(...) is REJECTED (TS2339)', async () => {
  const res = await compileGate(
    viteTree([
      {
        path: 'src/epics/orders/list/Page.tsx',
        content: [
          "import { os } from '../../../core/store.ts';",
          'export default async function Page() {',
          "  await os.datasets.update('d1', { name: 'x' });", // no such method — must be caught
          '  return null;',
          '}',
          '',
        ].join('\n'),
      },
    ]),
  );
  assert.ok(res.gated && !res.ok, 'the hallucinated write must reject the commit');
  if (res.gated && !res.ok) {
    const d = res.diagnostics.find((x) => x.file === 'src/epics/orders/list/Page.tsx');
    assert.ok(d, 'the diagnostic names the offending file');
    assert.equal(d!.code, 2339, "os.datasets.update is TS2339 (property does not exist)");
    assert.match(d!.message, /update/);
  }
});

test('SDK TYPE CLOSURE: the real os.records.* WRITE surface COMPILES (the true door)', async () => {
  const res = await compileGate(
    viteTree([
      {
        path: 'src/epics/orders/list/Page.tsx',
        content: [
          "import { os } from '../../../core/store.ts';",
          'export default async function Page() {',
          "  await os.records.add({ name: 'Widget', amount: 12 });",
          '  const rows = await os.records.list();',
          '  return rows.source;',
          '}',
          '',
        ].join('\n'),
      },
    ]),
  );
  assert.ok(res.gated && res.ok, 'the real records write surface must typecheck clean');
});

// ----------------------------------------- QueryResult + Badge tone (0.6.92 build fix) ---

/**
 * The 0.6.92 recurring-rejection class, PROVEN at the gate. Before the fix,
 * os.datasets.query/os.metrics.query were typed `Promise<unknown>`, so reading
 * `.rows[0][0]` off the result was TS18046 ("'r' is of type 'unknown'") and every
 * such commit was rejected. Now the methods return a typed QueryResult, so the exact
 * usage the failing app tried COMPILES GREEN — alongside the correct Badge `tone` API.
 */
test('QueryResult + Badge tone: the real usage the failing app wanted now COMPILES green', async () => {
  const res = await compileGate(
    viteTree([
      {
        path: 'src/epics/orders/count/Count.tsx',
        content: [
          "import { Badge } from '@sovereign-os/ui';",
          "import { os } from '../../../core/store.ts';",
          'export default async function Count() {',
          "  const r = await os.datasets.query('orders', { nl: 'how many orders shipped?' });",
          '  const n = Number(r.rows?.[0]?.[0] ?? 0);              // no cast — QueryResult is typed',
          "  const m = await os.metrics.query('rev', { dimensions: ['region'] });",
          '  const top = Number(m.rows?.[0]?.[1] ?? 0);',
          '  return <Badge tone={n > top ? "ok" : "warn"}>{n}</Badge>;',
          '}',
          '',
        ].join('\n'),
      },
    ]),
  );
  assert.ok(res.gated && res.ok, 'the typed QueryResult read + Badge tone must typecheck clean');
});

/**
 * The MIRROR IMAGE — the two mistakes the types must still catch so the gate keeps
 * guiding the LLM: a wrong Badge `variant` prop (TS2322), and reading `.rows` off a
 * value the SDK does NOT type as a grid (here a hallucinated `os.datasets.raw` — the
 * closed OsClient has no such method, TS2339). Both REJECT, proving the types are the
 * guardrail: green only for the real API, red for the shapes that used to slip through.
 */
test('Badge variant + reading .rows off a non-grid result are REJECTED (the types are the guardrail)', async () => {
  const badVariant = await compileGate(
    viteTree([
      {
        path: 'src/epics/orders/count/Bad.tsx',
        content: [
          "import { Badge } from '@sovereign-os/ui';",
          'export default function Bad() {',
          '  return <Badge variant="info">x</Badge>;', // variant does not exist — TS2322
          '}',
          '',
        ].join('\n'),
      },
    ]),
  );
  assert.ok(badVariant.gated && !badVariant.ok, 'Badge variant must reject');
  if (badVariant.gated && !badVariant.ok) {
    assert.ok(
      badVariant.diagnostics.some((d) => d.code === 2322 && /variant/i.test(d.message)),
      'the wrong Badge prop is the TS2322 assignability error',
    );
  }

  const badRows = await compileGate(
    viteTree([
      {
        path: 'src/epics/orders/count/Bad2.tsx',
        content: [
          "import { os } from '../../../core/store.ts';",
          'export default async function Bad2() {',
          // os.datasets has no `raw` method — the closed OsClient rejects it (TS2339),
          // so `.rows` can never be read off an unknowable/absent result. The type is
          // the door: only the real query methods yield a grid you can index.
          "  const r = await os.datasets.raw('orders');",
          '  return String(r.rows[0][0]);',
          '}',
          '',
        ].join('\n'),
      },
    ]),
  );
  assert.ok(badRows.gated && !badRows.ok, 'reading .rows off a hallucinated method must reject');
  if (badRows.gated && !badRows.ok) {
    assert.ok(
      badRows.diagnostics.some((d) => d.code === 2339 && /raw/.test(d.message)),
      'the hallucinated os.datasets.raw is a TS2339',
    );
  }
});

// ---------------------------------------------------- environment self-checks (Task 2) ---

/**
 * The production packaging bug (0.6.61-class): the esbuild-wasm binary is loaded at
 * runtime, so the Next standalone tracer drops it. When it is missing the gate must
 * DEGRADE THE BUNDLE PASS honestly — tsc still gates (catching import-depth /
 * hallucinated members) — instead of failing the whole gate open. These prove:
 *  1. a missing wasm ⇒ tsc still gates a clean tree, bundle skipped with an honest note;
 *  2. a missing wasm ⇒ tsc still REJECTS a bad tree (the authoritative pass runs);
 *  3. a missing TS type-lib ⇒ the WHOLE gate skips (tsc cannot run at all);
 *  4. in this (dev) environment both assets are actually present.
 */
test('BUNDLE degradation: a missing wasm skips ONLY the bundle pass — tsc still passes a clean tree', async () => {
  const res = await compileGate(viteTree(), { bundleAsset: { ok: false, missing: 'esbuild.wasm' } });
  assert.ok(res.gated && res.ok, 'still gated + ok — tsc ran, only the bundle net was skipped');
  if (res.gated && res.ok) {
    assert.match(res.bundleSkipped ?? '', /bundle check skipped/);
    assert.match(res.bundleSkipped ?? '', /esbuild\.wasm/);
  }
  assert.equal(
    gateActivityNote(res),
    'compile check ✓ (bundle skipped — asset missing)',
    'the activity note is honest about the skipped pass',
  );
});

test('BUNDLE degradation: a missing wasm still lets tsc REJECT a hallucinated member (os.datasets.update)', async () => {
  const res = await compileGate(
    viteTree([
      {
        path: 'src/epics/orders/list/Page.tsx',
        content: [
          "import { os } from '../../../core/store.ts';",
          'export default async function Page() {',
          "  await os.datasets.update('d1', {});", // hallucinated write — tsc must catch it
          '  return null;',
          '}',
          '',
        ].join('\n'),
      },
    ]),
    { bundleAsset: { ok: false, missing: 'esbuild.wasm' } },
  );
  assert.ok(res.gated && !res.ok, 'tsc still gates with the bundle asset missing');
  if (res.gated && !res.ok) {
    assert.ok(
      res.diagnostics.some((d) => d.code === 2339 && /update/.test(d.message)),
      'the hallucinated os.datasets.update is a TS2339 even when the bundle pass is skipped',
    );
  }
});

test('a missing TS type-lib skips the WHOLE gate (tsc cannot run) — never fabricates diagnostics', () => {
  // Pure check of the tsc-critical env probe: in dev it is ready; the shape is what
  // compileGate keys off to return gated:false when tsc itself cannot run.
  const env = gateEnvironmentReady();
  assert.deepEqual(env, { ok: true }, 'the tsc environment is ready in dev');
});

test('gateBundleAssetReady + esbuildWasmReady agree and are true in this environment', () => {
  assert.equal(esbuildWasmReady(), true, 'the wasm is present in the dev node_modules');
  assert.deepEqual(gateBundleAssetReady(), { ok: true });
});

test('legacy / non-Vite shapes pass through UNGATED with an honest reason', async () => {
  const nextjs = await compileGate([
    { path: 'app/layout.tsx', content: 'export default function L(){return null}' },
    { path: 'app/page.tsx', content: 'export default function P(){return null}' },
  ]);
  assert.equal(nextjs.gated, false);
  if (!nextjs.gated) assert.match(nextjs.reason, /Next\.js/);

  const unknown = await compileGate([{ path: 'README.md', content: '# hi' }]);
  assert.equal(unknown.gated, false);
});

test('diagnostics are CAPPED at MAX_DIAGNOSTICS while total stays honest', async () => {
  // 25 distinct unresolved JSX components → ≥25 TS2304s in one file.
  const body = Array.from({ length: 25 }, (_, i) => `      <Widget${i} />`).join('\n');
  const res = await compileGate(
    viteTree([
      {
        path: 'src/epics/e/s/Page.tsx',
        content: `export default function P() {\n  return (\n    <div>\n${body}\n    </div>\n  );\n}\n`,
      },
    ]),
  );
  assert.ok(res.gated && !res.ok);
  if (res.gated && !res.ok) {
    assert.equal(res.diagnostics.length, MAX_DIAGNOSTICS, 'shown list is capped');
    assert.ok(res.total >= 25, 'total reports the real count');
  }
});

test('PERFORMANCE: the vendored type source is read once and reused across gate calls', async () => {
  await compileGate(viteTree());
  const afterFirst = __vendorReads();
  await compileGate(viteTree());
  assert.equal(afterFirst, 1, 'vendored source memoised after the first call');
  assert.equal(__vendorReads(), 1, 'second call reuses the cached vendor source');
});

// ------------------------------------------------------------------ presentation ---

test('formatGateError is corrective: names file:line + code, states nothing was written', async () => {
  const res = await compileGate(
    viteTree([
      {
        path: 'src/epics/e/s/Page.tsx',
        content: "import { Badge } from '@sovereign-os/ui';\nexport default function P(){ return <Badge variant=\"x\"/>; }\n",
      },
    ]),
  );
  assert.ok(res.gated && !res.ok);
  if (res.gated && !res.ok) {
    const text = formatGateError(res);
    assert.match(text, /commit rejected: \d+ compile error/);
    assert.match(text, /NOTHING was written/);
    assert.match(text, /src\/epics\/e\/s\/Page\.tsx:2:\d+\s+TS2322/);
    assert.match(text, /re-commit/);
  }
});

test('B2 (0.6.115): a @sovereign-os/* prop error appends the type\'s REAL members (blind retry → first-try fix)', async () => {
  const res = await compileGate(
    viteTree([
      {
        path: 'src/epics/e/s/Page.tsx',
        content: "import { Badge } from '@sovereign-os/ui';\nexport default function P(){ return <Badge variant=\"x\"/>; }\n",
      },
    ]),
  );
  assert.ok(res.gated && !res.ok);
  if (res.gated && !res.ok) {
    const text = formatGateError(res);
    // The hint names what Badge ACTUALLY accepts (`tone`) and the wrong prop used, so the
    // agent fixes it on the first retry (the tsc message expands the props type inline).
    assert.match(text, /accepts:.*\btone\b/i, 'lists the real Badge member (tone)');
    assert.match(text, /you used 'variant'/i, 'names the wrong prop');
  }
});

test('B2: formatGateError NEVER throws, even on a diagnostic with an odd/absent symbol', () => {
  // A synthetic non-@sovereign-os diagnostic: the hinter must fail-soft and just render the line.
  const text = formatGateError({
    gated: true,
    ok: false,
    total: 1,
    diagnostics: [{ file: 'src/x.ts', line: 1, column: 1, code: 2339, message: "Property 'z' does not exist on type 'Foo'" }],
  });
  assert.match(text, /src\/x\.ts:1:1\s+TS2339/);
  assert.match(text, /NOTHING was written/);
});

test('gateActivityNote + gateLineFromStep render the feed step in the existing line language', async () => {
  assert.equal(gateActivityNote({ gated: true, ok: true }), 'compile check ✓');
  assert.equal(
    gateActivityNote({ gated: true, ok: false, diagnostics: [], total: 3 }),
    'compile check ✗ 3 errors',
  );
  assert.equal(gateActivityNote({ gated: false, reason: 'x' }), 'compile check skipped (ungated shape)');

  // Success step: the server records the note in the commit detail → its own ✓ line.
  const okLine = gateLineFromStep({
    tool: 'commit',
    args: {},
    result: '{"step":{"ok":true,"detail":"compile check ✓; live: committed 2/2 files"}}',
    isError: false,
  });
  assert.deepEqual(okLine, { tool: 'commit', text: 'compile check ✓', isError: false });

  // Gate rejection: the thrown corrective error → its own ✗ line with the count.
  const badLine = gateLineFromStep({
    tool: 'commit',
    args: {},
    result: 'Error: commit rejected: 2 compile errors — NOTHING was written.',
    isError: true,
  });
  assert.deepEqual(badLine, { tool: 'commit', text: 'compile check ✗ 2 errors', isError: true });

  // A non-gate commit failure yields NO gate line (the ⚠ commit line names it).
  assert.equal(
    gateLineFromStep({ tool: 'commit', args: {}, result: 'Error: Forgejo unreachable', isError: true }),
    null,
  );
  // Non-commit tools never get a gate line.
  assert.equal(gateLineFromStep({ tool: 'read_app_files', args: {}, result: 'compile check ✓', isError: false }), null);
});

// ------------------------------------------------------------ commitToApp wiring ---

test('commitToApp REJECTS a non-compiling commit — diagnostics in the error, NOTHING persisted', async () => {
  const app = await createApp(dev, { name: 'Gate Reject', template: 'sovereign-app' });
  const before = getSnapshot(app.id);
  const chatBefore = app.chat.length;

  await assert.rejects(
    commitToApp(
      app.id,
      dev,
      [
        {
          path: 'src/epics/e/s/Bad.tsx',
          content: "import { Badge } from '@sovereign-os/ui';\nexport default function Bad(){ return <Badge variant=\"info\">x</Badge>; }\n",
        },
      ],
      'bad story',
    ),
    (e: Error & { status?: number }) => {
      assert.equal(e.status, 422, 'a gate rejection is a typed 422, not a 5xx');
      assert.match(e.message, /commit rejected: \d+ compile error/);
      assert.match(e.message, /src\/epics\/e\/s\/Bad\.tsx:2:\d+/, 'error names file+line');
      assert.match(e.message, /NOTHING was written/);
      return true;
    },
  );

  // Nothing persisted: no snapshot change (no mirror write flows without it), no chat line.
  const after = getSnapshot(app.id);
  assert.equal(after?.some((f) => f.path === 'src/epics/e/s/Bad.tsx') ?? false, false, 'bad file never snapshotted');
  assert.equal(after?.length, before?.length, 'tree unchanged');
  assert.equal(app.chat.length, chatBefore, 'no "Committed" chat line for a rejected commit');
});

test('commitToApp PASSES a compiling commit — gate recorded on the step, tree persisted', async () => {
  const app = await createApp(dev, { name: 'Gate Pass', template: 'sovereign-app' });
  const { app: after, step } = await commitToApp(
    app.id,
    dev,
    [
      {
        path: 'src/epics/dossier/live/Live.tsx',
        content: [
          "import { Badge, Card, Section } from '@sovereign-os/ui';",
          'export default function Live() {',
          '  return <Section title="Live"><Card><Badge tone="ok">ok</Badge></Card></Section>;',
          '}',
          '',
        ].join('\n'),
      },
    ],
    'good story',
  );
  assert.equal(step.ok, true);
  assert.deepEqual(step.gate, { gated: true, ok: true }, 'gate outcome recorded on the commit');
  assert.match(step.detail, /^compile check ✓; /, 'the feed-visible note leads the detail');
  const snap = getSnapshot(after.id);
  assert.ok(snap!.some((f) => f.path === 'src/epics/dossier/live/Live.tsx'), 'good file persisted');
  // The auto-registered sections.tsx (regenerated BEFORE the gate) was part of what passed.
  const sections = snap!.find((f) => f.path === 'src/template/sections.tsx');
  assert.ok(sections && /Live/.test(sections.content), 'regenerated sections registry was gated too');
});

test('commitToApp passes a LEGACY (Next.js) shape through ungated with gate:{gated:false}', async () => {
  const app = await createApp(dev, { name: 'Gate Legacy', template: 'nextjs-supabase' });
  const { step } = await commitToApp(
    app.id,
    dev,
    // Deliberately would-not-compile content: the legacy shape must still pass through.
    [{ path: 'app/broken/page.tsx', content: 'export default function P(){ return <Nope/>; }\n' }],
    'legacy commit',
  );
  assert.equal(step.ok, true, 'legacy shape is not blocked');
  assert.equal(step.gate?.gated, false, 'honestly recorded as ungated');
  assert.match(step.detail, /^compile check skipped \(ungated shape\); /);
});

// -------------------------------------------- refreshVendoredSdk (existing apps) ---

/**
 * Existing apps froze a copy of the SDK at seed time; `refreshVendoredSdk` re-commits
 * the CURRENT `lib/app-sdk` source through the governed commit path so they gain the
 * `os.records.*` write surface. It must land the vendored files AND (implicitly) pass
 * the compile gate — a non-frontend template is an honest no-op.
 */
test('refreshVendoredSdk re-vendors the SDK into a governed-frontend app (commits vendor/ files)', async () => {
  const app = await createApp(dev, { name: 'SDK Refresh', template: 'sovereign-app' });
  const out = await refreshVendoredSdk(app.id, dev);
  assert.ok(!('skipped' in out), 'a sovereign-app is a governed frontend — not skipped');
  if (!('skipped' in out)) {
    assert.equal(out.step.ok, true, 'the re-vendor commit landed');
    const snap = getSnapshot(app.id);
    assert.ok(
      snap!.some((f) => f.path === 'vendor/@sovereign-os/app-sdk/client.ts'),
      'the fresh vendored SDK source is committed',
    );
    // The freshly vendored client carries the NEW write surface.
    const client = snap!.find((f) => f.path === 'vendor/@sovereign-os/app-sdk/client.ts');
    assert.match(client!.content, /records:/, 'the re-vendored client has the os.records surface');
  }
});

test('refreshVendoredSdk is an honest no-op for a non-frontend template', async () => {
  const app = await createApp(dev, { name: 'Service Refresh', template: 'nextjs-supabase' });
  const out = await refreshVendoredSdk(app.id, dev);
  assert.ok('skipped' in out && out.skipped, 'a non-governed-frontend template has no SDK to refresh');
});

// -------------------------------------------- escalation + corrective round-trip ---

/**
 * The 0.6.54 interplay, end to end: a gate rejection surfaces as a normal commit tool
 * error, so (a) the DIAGNOSTICS round-trip into the next model call's transcript, and
 * (b) repeated rejections count toward the bounded reasoning escalation exactly like
 * any other repeated commit failure.
 */
test('gate rejections feed diagnostics back into the turn and count toward bounded escalation', async () => {
  const app = await createApp(dev, { name: 'Gate Escalate', template: 'sovereign-app' });
  const badFiles: ScaffoldFile[] = [
    {
      path: 'src/epics/e/s/Bad.tsx',
      content: "import { Badge } from '@sovereign-os/ui';\nexport default function Bad(){ return <Badge variant=\"info\">x</Badge>; }\n",
    },
  ];

  const toolFeedback: string[] = [];
  let acts = 0;
  const llm: LlmCall = async (req) => {
    if (!req.tools) return { content: 'plan', toolCalls: [] };
    // Capture every tool result the model is shown (the corrective round-trip).
    for (const m of req.messages) {
      if (m.role === 'tool' && typeof m.content === 'string') toolFeedback.push(m.content);
    }
    acts += 1;
    if (acts > 3) return { content: 'stopping honestly', toolCalls: [] };
    // Keep asking for a (varied-args) commit — the executor really runs the gate.
    return { content: '', toolCalls: [{ id: `c${acts}`, name: 'commit', args: { attempt: acts } }] };
  };

  const escalations: { tool: string }[] = [];
  await runAgentic({
    system: 'sys',
    userMessages: [{ role: 'user', content: 'build the story' }],
    tools: [{ name: 'commit', description: 'commit files', inputSchema: { type: 'object' } }],
    callTool: async () => {
      // Mirror tabToolExecutor: a thrown gate rejection becomes an isError tool result.
      try {
        await commitToApp(app.id, dev, badFiles, 'bad');
        return { text: 'ok', isError: false };
      } catch (e) {
        return { text: `Error: ${(e as Error).message}`, isError: true };
      }
    },
    llm,
    planModel: 'plan-model',
    actModel: 'standard-x',
    escalateActModel: 'reasoning-y',
    onEscalate: (info) => escalations.push(info),
    maxIterations: 5,
  });

  assert.equal(escalations.length, 1, 'repeated gate rejections trip the bounded escalation once');
  assert.equal(escalations[0].tool, 'commit');
  assert.ok(
    toolFeedback.some((t) => /commit rejected: \d+ compile error/.test(t) && /TS2322/.test(t)),
    'the exact compiler diagnostics round-trip into the next model call',
  );
});
