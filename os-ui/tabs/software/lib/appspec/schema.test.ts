/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
/**
 * schema.test — the STRUCTURAL gate for the v2 (tabs·patterns·custom) grammar. A valid spec
 * parses to the typed AppSpec; each malformed field yields the RIGHT typed `{path,reason,fix}`
 * issue; an unknown pattern id / body kind is rejected; a custom block's size cap and theme cap
 * are enforced. Hand-written validator (Zod is not a repo dependency), so these tests pin the
 * exact `{ ok, issues }` contract the authoring tools rely on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAppSpec, CUSTOM_HTML_MAX, THEME_CSS_MAX, type ParseResult, type SpecIssue } from './schema.ts';

/** A structurally-complete, valid v2 spec covering a pattern tab + a custom tab + a theme. */
function validSpec(): unknown {
  return {
    version: 2,
    name: 'Ops Console',
    description: 'A worked demo app.',
    theme: { css: '.card { border-radius: 8px; }' },
    tabs: [
      {
        id: 'orders',
        label: 'Orders',
        icon: '📋',
        roleGate: 'builder',
        body: {
          kind: 'pattern',
          pattern: 'records-table',
          config: {
            source: { datasetId: 'ds_orders' },
            columns: [
              { field: 'order_id', label: 'Order' },
              { field: 'amount', format: 'currency-eur' },
            ],
            filters: [{ field: 'status', control: 'select' }],
            sort: 'amount',
            search: true,
            pageSize: 25,
          },
        },
      },
      {
        id: 'intake',
        label: 'New order',
        body: {
          kind: 'pattern',
          pattern: 'intake-wizard',
          config: {
            target: 'records',
            steps: [{ title: 'Basics', fields: [{ name: 'note', label: 'Note', type: 'text', required: true }] }],
            submitLabel: 'Create',
          },
        },
      },
      {
        id: 'board',
        label: 'Board',
        body: {
          kind: 'pattern',
          pattern: 'status-board',
          config: { source: { datasetId: 'ds_orders' }, statusField: 'status', titleField: 'order_id' },
        },
      },
      {
        id: 'widget',
        label: 'Widget',
        body: { kind: 'custom', html: '<h1>Hi</h1>', css: 'h1{color:red}', js: 'console.log(1)', data: { datasetId: 'ds_orders', as: 'orders' } },
      },
    ],
  };
}

function issuesOf(r: ParseResult): SpecIssue[] {
  assert.equal(r.ok, false, 'expected parse to FAIL');
  return (r as { ok: false; issues: SpecIssue[] }).issues;
}

function hasIssue(issues: SpecIssue[], path: string): SpecIssue {
  const found = issues.find((i) => i.path === path);
  assert.ok(found, `expected an issue at path "${path}", got: ${JSON.stringify(issues.map((i) => i.path))}`);
  return found!;
}

test('a fully valid v2 spec parses to the typed AppSpec (pattern + custom + theme)', () => {
  const r = parseAppSpec(validSpec());
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify((r as { issues: SpecIssue[] }).issues));
  if (r.ok) {
    assert.equal(r.spec.version, 2);
    assert.equal(r.spec.tabs.length, 4);
    assert.equal(r.spec.theme?.css, '.card { border-radius: 8px; }');
    const t0 = r.spec.tabs[0];
    assert.equal(t0.roleGate, 'builder');
    assert.equal(t0.body.kind, 'pattern');
    if (t0.body.kind === 'pattern') {
      assert.equal(t0.body.pattern, 'records-table');
      assert.equal((t0.body.config as { pageSize?: number }).pageSize, 25);
    }
    const custom = r.spec.tabs[3];
    assert.equal(custom.body.kind, 'custom');
    if (custom.body.kind === 'custom') assert.equal(custom.body.data?.as, 'orders');
  }
});

test('BACKWARD-COMPAT: a legacy 3.5a-era v2 spec (no theme/functions/stories/icon/roleGate) still parses', () => {
  // This is the SHAPE a live-cohort app saved before Phases 3.5b–3.5d existed. `setAppSpec` stores
  // the re-parsed output, so a spec saved then MUST keep parsing now — otherwise the Build-chat
  // assistant refuses ("I could not read the current app"). The parser only ever got LOOSER
  // (description became optional in 0.6.130), so every historical v2 spec must round-trip.
  const legacy = {
    version: 2,
    name: 'Orders',
    description: 'Track orders',
    tabs: [
      {
        id: 't1',
        label: 'Orders',
        body: {
          kind: 'pattern',
          pattern: 'records-table',
          config: {
            source: { datasetId: 'ds_orders' },
            columns: [{ field: 'id' }, { field: 'total', format: 'currency-eur' }],
          },
        },
      },
    ],
  };
  const r = parseAppSpec(legacy);
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify((r as { issues: SpecIssue[] }).issues));
  if (r.ok) {
    assert.equal(r.spec.tabs.length, 1);
    assert.equal(r.spec.theme, undefined);
    assert.equal(r.spec.functions, undefined);
    assert.equal(r.spec.tabs[0].stories, undefined);
  }
});

test('BACKWARD-COMPAT: a legacy spec with a KPI card (metric source only) survives the 3.5d function-source addition', () => {
  // 3.5d added a THIRD kpi-card source (`function`). A card authored in 3.5b with only `metric`
  // must still satisfy the "exactly one source" rule — the addition must not have broken it.
  const legacyKpi = {
    version: 2,
    name: 'KPIs',
    description: 'Numbers',
    tabs: [
      {
        id: 'k',
        label: 'KPIs',
        body: {
          kind: 'pattern',
          pattern: 'kpi-overview',
          config: { cards: [{ label: 'Revenue', metric: { metricId: 'm_rev' } }] },
        },
      },
    ],
  };
  assert.equal(parseAppSpec(legacyKpi).ok, true);
});

test('version must be the literal 2', () => {
  const bad = { ...(validSpec() as object), version: 1 };
  const i = hasIssue(issuesOf(parseAppSpec(bad)), 'version');
  assert.match(i.reason, /literal 2/);
  assert.match(i.fix, /set version to 2/);
});

test('a missing name and empty tabs are issues; a missing description is NOT (it is optional metadata)', () => {
  const issues = issuesOf(parseAppSpec({ version: 2, tabs: [] }));
  const name = hasIssue(issues, 'name');
  assert.match(name.reason, /required/);
  hasIssue(issues, 'tabs');
  // The no-code composer exposes no description field, so a missing/empty description must
  // never block a save (0.6.130) — the parser coerces it to '' rather than erroring.
  assert.equal(issues.some((i) => i.path === 'description'), false);
});

test('an unknown body kind is rejected with the allowed set in the fix', () => {
  const spec = validSpec() as { tabs: { body: unknown }[] };
  spec.tabs[0].body = { kind: 'chart' };
  const i = hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[0].body.kind');
  assert.match(i.fix, /pattern, custom/);
});

test('an unknown pattern id is rejected naming a valid id set', () => {
  const spec = validSpec() as { tabs: { body: { pattern?: string } }[] };
  spec.tabs[0].body.pattern = 'pivot';
  const i = hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[0].body.pattern');
  assert.match(i.reason, /not valid/);
  assert.match(i.fix, /records-table/);
});

test('a pattern body missing its config is rejected at the config path', () => {
  const spec = validSpec() as { tabs: { body: Record<string, unknown> }[] };
  delete spec.tabs[0].body.config;
  hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[0].body.config');
});

test('records-table config: a bad column format is a typed issue at the exact path', () => {
  const spec = validSpec() as { tabs: { body: { config?: { columns?: { format?: string }[] } } }[] };
  spec.tabs[0].body.config!.columns![1].format = 'money';
  const i = hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[0].body.config.columns[1].format');
  assert.match(i.fix, /text, number, currency-eur, date, badge/);
});

test('records-table config: a bad filter control names the allowed controls', () => {
  const spec = validSpec() as { tabs: { body: { config?: { filters?: { control?: string }[] } } }[] };
  spec.tabs[0].body.config!.filters![0].control = 'toggle';
  const i = hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[0].body.config.filters[0].control');
  assert.match(i.fix, /select, search, range/);
});

test('records-table config: missing columns is rejected at the columns path', () => {
  const spec = validSpec() as { tabs: { body: { config?: Record<string, unknown> } }[] };
  delete spec.tabs[0].body.config!.columns;
  hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[0].body.config.columns');
});

test('intake-wizard config: a step field with an unknown type is rejected at the field path', () => {
  const spec = validSpec() as { tabs: { body: { config?: { steps?: { fields?: { type?: string }[] }[] } } }[] };
  spec.tabs[1].body.config!.steps![0].fields![0].type = 'datetime';
  const i = hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[1].body.config.steps[0].fields[0].type');
  assert.match(i.fix, /text, number, date, boolean/);
});

test('status-board config: missing statusField is rejected at its path', () => {
  const spec = validSpec() as { tabs: { body: { config?: Record<string, unknown> } }[] };
  delete spec.tabs[2].body.config!.statusField;
  hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[2].body.config.statusField');
});

test('an invalid roleGate is a typed issue with the ladder in the fix', () => {
  const spec = validSpec() as { tabs: { roleGate?: string }[] };
  spec.tabs[0].roleGate = 'superuser';
  const i = hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[0].roleGate');
  assert.match(i.fix, /creator, builder, domain_admin, admin/);
});

test('a custom block missing html is rejected; oversize html is capped', () => {
  const noHtml = validSpec() as { tabs: { body: Record<string, unknown> }[] };
  delete noHtml.tabs[3].body.html;
  hasIssue(issuesOf(parseAppSpec(noHtml)), 'tabs[3].body.html');

  const big = validSpec() as { tabs: { body: { html?: string } }[] };
  big.tabs[3].body.html = 'x'.repeat(CUSTOM_HTML_MAX + 1);
  const i = hasIssue(issuesOf(parseAppSpec(big)), 'tabs[3].body.html');
  assert.match(i.reason, /too large/);
});

test('an oversize theme css is capped at author time', () => {
  const spec = validSpec() as { theme: { css: string } };
  spec.theme.css = 'a'.repeat(THEME_CSS_MAX + 1);
  const i = hasIssue(issuesOf(parseAppSpec(spec)), 'theme.css');
  assert.match(i.reason, /too large/);
});

// --- Security (0.6.131): theme.css cannot contain `<` or `>` --------------------------
// theme.css is injected same-origin into the trusted OS DOM via <style dangerouslySetInnerHTML>.
// The HTML tokenizer ends a <style> at the first `</style>` (even inside a CSS string/url()), so
// any `<`/`>` is a stored-XSS breakout vector. Legit CSS never needs either, so parseAppSpec
// BLOCKS a theme.css containing them (path theme.css) — a malicious theme never persists.
for (const [name, css] of [
  ['content-string breakout', '.x { content: "</style><img src=x onerror=alert(1)>"; }'],
  ['raw script breakout', 'foo</style><script>alert(1)</script> { color:red }'],
  ['font-face url() breakout', '@font-face { src: url("</style><script>alert(1)</script>"); }'],
] as const) {
  test(`theme.css with a ${name} is blocked at validation`, () => {
    const spec = validSpec() as { theme: { css: string } };
    spec.theme.css = css;
    const i = hasIssue(issuesOf(parseAppSpec(spec)), 'theme.css');
    assert.match(i.reason, /cannot contain/i);
  });
}

test('a non-object input is rejected with a root-path issue', () => {
  const i = hasIssue(issuesOf(parseAppSpec(42)), '');
  assert.match(i.reason, /must be an object/);
});

test('every reported issue carries a path, reason, and fix (typed contract)', () => {
  const issues = issuesOf(parseAppSpec({ version: 9, name: '', tabs: 'nope' }));
  for (const i of issues) {
    assert.equal(typeof i.path, 'string');
    assert.ok(i.reason.length > 0);
    assert.ok(i.fix.length > 0);
  }
});

test('a tab’s optional stories parse into typed StoryRefs (3.5b, additive)', () => {
  const spec = validSpec() as { tabs: { stories?: unknown }[] };
  spec.tabs[0].stories = [{ epicId: 'ep1', storyId: 's1' }, { epicId: 'ep1', storyId: 's2' }];
  const r = parseAppSpec(spec);
  assert.equal(r.ok, true, r.ok ? '' : JSON.stringify((r as { issues: SpecIssue[] }).issues));
  if (r.ok) assert.deepEqual(r.spec.tabs[0].stories, [{ epicId: 'ep1', storyId: 's1' }, { epicId: 'ep1', storyId: 's2' }]);
});

test('a malformed story ref (missing storyId) is a structural issue', () => {
  const spec = validSpec() as { tabs: { stories?: unknown }[] };
  spec.tabs[0].stories = [{ epicId: 'ep1' }];
  hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[0].stories[0].storyId');
});

test('stories must be an array when present', () => {
  const spec = validSpec() as { tabs: { stories?: unknown }[] };
  spec.tabs[0].stories = 'nope';
  hasIssue(issuesOf(parseAppSpec(spec)), 'tabs[0].stories');
});
