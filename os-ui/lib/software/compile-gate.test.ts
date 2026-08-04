/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@/lib/core/auth';
import { runAgentic, type LlmCall } from '@/lib/assistant/agentic';
import { createApp } from '@/lib/software/apps';
import { commitToApp, getSnapshot } from './server.ts';
import { sovereignAppFiles } from './scaffolds/sovereign-app.ts';
import {
  compileGate,
  formatGateError,
  gateActivityNote,
  MAX_DIAGNOSTICS,
  __vendorReads,
} from './compile-gate.ts';
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
