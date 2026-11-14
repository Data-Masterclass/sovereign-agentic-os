/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The all-kinds enumeration — no builder artefact kind whose writer does not commit
 * USER STORY: As a maintainer I want a NEW object kind, and a NEW writer of the domain repo, to
 *             FAIL this test until it is classified: committed (naming the writer module that
 *             reaches the one commit path), landing with a named stream, or deliberately backlog
 *             with a reason. Forgetting a kind must be a failure, not a silent gap (checklist G1,
 *             decision D23 — the X1 pattern, generalised from one tab to every kind).
 * ARCHITECTURE:
 *   - Two directions, and BOTH matter:
 *     (1) every kind in `GIT_OBJECT_KINDS` declares a repo path and a writer state, and a kind
 *         claiming `committed` names a module that EXISTS and reaches `commitTree`/`commitSubtree`;
 *     (2) every module that imports those primitives is CLAIMED by some kind (or is listed here
 *         as infrastructure with a reason) — so a writer added for a new artefact kind fails this
 *         test until the kind table learns about it.
 *   - Filesystem + regex only: no tab import (the kernel may not import a tab), no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { GIT_OBJECT_KINDS, GIT_OBJECT_LAYOUT, type GitObjectKind } from '@core/infra/git-objects';

/** os-ui's root, from this test's own location (`core/infra/`). */
const UI = join(import.meta.dirname, '..', '..');

/**
 * THE CLOSED SET, pinned. Adding a kind to `GIT_OBJECT_KINDS` without adding it here is a
 * failure — which is the point: the list of things the OS builds may not grow in silence.
 */
const EXPECTED_KINDS: GitObjectKind[] = [
  'dataset',
  'metric',
  'dashboard',
  'agent-system',
  'software',
  'lifecycle-pin',
  'knowledge-workflow',
  'connection-config',
];

/**
 * Modules that reach the commit primitives WITHOUT owning an artefact kind. Each needs a reason,
 * and the list is deliberately tiny: anything else is a writer of somebody's artefact.
 */
const INFRASTRUCTURE: Record<string, string> = {
  'core/infra/git-store.ts': 'the commit path itself',
  'core/infra/git-objects.ts': 'the generic read-back; it writes nothing',
};

const COMMIT_PRIMITIVES = /\b(commitTree|commitSubtree)\b/;

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry.startsWith('.')) continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
  }
  return out;
}

/** Every source module that IMPORTS a commit primitive from the git store. */
function writerModules(): string[] {
  const found: string[] = [];
  for (const file of [...walk(join(UI, 'core')), ...walk(join(UI, 'tabs')), ...walk(join(UI, 'app')), ...walk(join(UI, 'worker'))]) {
    const text = readFileSync(file, 'utf8');
    const imports = [...text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(@core\/infra\/git-store|@core\/infra\/git-objects)'/g)];
    if (imports.some((m) => COMMIT_PRIMITIVES.test(m[1]))) found.push(relative(UI, file).split('\\').join('/'));
  }
  return found.sort();
}

test('G1: the kind list is the closed set the table declares, in one place', () => {
  assert.deepEqual([...GIT_OBJECT_KINDS], EXPECTED_KINDS, 'a new object kind must be added to this test too — that is the gate');
  assert.deepEqual(Object.keys(GIT_OBJECT_LAYOUT).sort(), [...EXPECTED_KINDS].sort(), 'every kind needs a layout row');
});

test('G1: every kind declares WHERE it lives and WHETHER its writer commits', () => {
  // A kind may SHARE another kind's landed commit path (a dbt metric is written by the same dbt
  // commit module as a dbt model) — what is still landing for it is the EMITTER of its files, not
  // the commit path. So the "flip it to committed" reminder only fires for a via nobody has landed.
  const committedVias = new Set(
    GIT_OBJECT_KINDS.map((k) => GIT_OBJECT_LAYOUT[k].writer).filter((w) => w.state === 'committed').map((w) => (w as { via: string }).via),
  );
  for (const kind of GIT_OBJECT_KINDS) {
    const row = GIT_OBJECT_LAYOUT[kind];
    assert.ok(row.paths.length > 0 && row.paths.every((p) => p.length > 0), `${kind}: no repo path`);
    assert.ok(!row.paths.some((p) => p.startsWith('/')), `${kind}: a repo path is relative, never absolute`);
    switch (row.writer.state) {
      case 'committed': {
        const module = join(UI, row.writer.via);
        assert.ok(existsSync(module), `${kind}: claims a committed writer at ${row.writer.via}, which does not exist`);
        assert.match(
          readFileSync(module, 'utf8'),
          COMMIT_PRIMITIVES,
          `${kind}: ${row.writer.via} does not reach commitTree/commitSubtree — a writer that does not commit may not be called committed`,
        );
        assert.ok(row.writer.since.length > 0, `${kind}: committed without saying since when`);
        break;
      }
      case 'landing': {
        assert.ok(row.writer.stream.length > 3, `${kind}: landing without naming the stream that lands it`);
        // If the writer HAS landed, the row must be flipped to `committed` — a one-line change,
        // and this assertion is how the coordinator is reminded at merge time.
        const module = join(UI, row.writer.via);
        if (!committedVias.has(row.writer.via) && existsSync(module) && COMMIT_PRIMITIVES.test(readFileSync(module, 'utf8'))) {
          assert.fail(`${kind}: ${row.writer.via} now commits — flip this row from 'landing' to 'committed'`);
        }
        break;
      }
      case 'backlog':
        assert.ok(row.writer.reason.length > 20, `${kind}: backlog without a reason anybody could act on`);
        break;
      default:
        assert.fail(`${kind}: unclassified writer state`);
    }
  }
});

test('G1: no module commits to a domain repo without a kind claiming it', () => {
  const claimed = new Set<string>();
  for (const kind of GIT_OBJECT_KINDS) {
    const w = GIT_OBJECT_LAYOUT[kind].writer;
    if (w.state !== 'backlog') claimed.add(w.via);
  }
  const unclaimed = writerModules().filter((m) => !claimed.has(m) && !(m in INFRASTRUCTURE));
  assert.deepEqual(
    unclaimed,
    [],
    'these modules commit to a domain repository but no object kind claims them — classify each in GIT_OBJECT_LAYOUT (or, if it really is infrastructure, in this test\'s INFRASTRUCTURE map with a reason)',
  );
  // And the two known writers really are found by the scan, so a broken scan cannot pass vacuously.
  const modules = writerModules();
  assert.ok(modules.includes('tabs/data/lib/dbt/commit.ts'), 'the dbt writer must be discovered by the scan');
  assert.ok(modules.includes('tabs/agents/lib/git/commit.ts'), 'the agent-system writer must be discovered by the scan');
});

/**
 * THE FLIP STEP — read this when this test fails after a merge.
 *
 * The two lists below pin TODAY'S classification on purpose: they are the reminder that a newly
 * landed writer must be declared. When a stream lands the writer for `metric`, `dashboard`,
 * `software` or `lifecycle-pin`:
 *   1. flip that kind's row in `GIT_OBJECT_LAYOUT` from `{state:'landing', …}` to
 *      `{state:'committed', via:'<module>', since:'<when>'}`;
 *   2. move its name from `landing` to `committed` in the assertions below;
 *   3. update the layout table in `docs/components/git.md`.
 * Nothing else needs to change — and a writer that lands WITHOUT step 1 fails the test above.
 */
test('G1: the kinds that are NOT in git yet say so, and the two that are name a real writer', () => {
  const committed = GIT_OBJECT_KINDS.filter((k) => GIT_OBJECT_LAYOUT[k].writer.state === 'committed');
  const landing = GIT_OBJECT_KINDS.filter((k) => GIT_OBJECT_LAYOUT[k].writer.state === 'landing');
  const backlog = GIT_OBJECT_KINDS.filter((k) => GIT_OBJECT_LAYOUT[k].writer.state === 'backlog');
  // Night-2 merge: every writer the night promised landed — M's semantic emitter, D's
  // `tabs/dashboards/lib/git/commit.ts`, S's `tabs/software/lib/git-commit.ts` and V's
  // `core/infra/lifecycle-pins.ts` — so all four rows moved from `landing` to `committed`
  // (step 2 of the FLIP STEP above) and NOTHING is landing any more. The two backlog kinds keep
  // their reasons: that is the honest remainder, not a gap in this test.
  assert.deepEqual(
    committed,
    ['dataset', 'metric', 'dashboard', 'agent-system', 'software', 'lifecycle-pin'],
    'these kinds have a landed git writer',
  );
  assert.deepEqual(landing, [], 'night 2 landed every writer it declared');
  assert.deepEqual(backlog, ['knowledge-workflow', 'connection-config'], 'these are the honest backlog, with reasons');
  assert.equal(committed.length + landing.length + backlog.length, GIT_OBJECT_KINDS.length, 'every kind is classified exactly once');
});

// ------------------------------------------------ the documentation tripwire ---

/**
 * `docs/components/git.md` carries the SAME layout table as `GIT_OBJECT_LAYOUT`, and an engineer
 * is told to trust the page. Before this test it had drifted into naming a module that does not
 * exist (`tabs/software/lib/git/commit.ts`) and the wrong file for lifecycle pins
 * (`os/lifecycle.yml` instead of `os/lifecycle/pins.yml`) — a wrong path on the page you are sent
 * to is worse than no page. So the page is parsed and compared, row by row.
 *
 * What is compared: the kind token, the path selectors, the personal lane, and the writer's module
 * and state. What is NOT compared: the prose after the kind token and the `since` field — a human
 * label may read differently from the code's `label`, and `since` is a changelog, not a contract.
 */
type DocRow = { kind: string; paths: string[]; lane: string | null; writerVia: string | null; writerState: string };

const DOCS_TABLE = join(UI, '..', 'docs', 'components', 'git.md');
const TABLE_HEADER = '| Object kind | Path in the domain repo | Personal lane | Writer |';
/** The one row that is deliberately NOT an object kind: OS-owned governance metadata. */
const NON_KIND_MARKER = '*(not an object kind)*';

function code(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
}

function parseDocsTable(): { rows: DocRow[]; nonKind: string[] } {
  assert.ok(existsSync(DOCS_TABLE), `the authoritative layout table must exist at ${DOCS_TABLE}`);
  const lines = readFileSync(DOCS_TABLE, 'utf8').split('\n');
  const start = lines.indexOf(TABLE_HEADER);
  assert.ok(start >= 0, `docs/components/git.md must still carry the layout table, header exactly: ${TABLE_HEADER}`);
  const rows: DocRow[] = [];
  const nonKind: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break; // the table ends at the first non-table line
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    assert.equal(cells.length, 4, `every table row needs four cells: ${line}`);
    const [kindCell, pathsCell, laneCell, writerCell] = cells;
    if (kindCell.startsWith(NON_KIND_MARKER)) {
      nonKind.push(code(pathsCell).join(', '));
      continue;
    }
    const kind = code(kindCell)[0];
    assert.ok(kind, `row 1 must start with the GitObjectKind in backticks (or "${NON_KIND_MARKER}"): ${line}`);
    const laneCodes = code(laneCell);
    const backlog = /\*\*backlog\*\*/.test(writerCell);
    const state = backlog ? 'backlog' : (writerCell.match(/\*\*(committed)\*\*|\b(landing)\b/)?.slice(1).find(Boolean) ?? '');
    rows.push({
      kind,
      paths: code(pathsCell),
      lane: laneCell === '—' ? null : (laneCodes[0] ?? null),
      writerVia: backlog ? null : (code(writerCell)[0] ?? null),
      writerState: state,
    });
  }
  return { rows, nonKind };
}

test('G2: docs/components/git.md’s layout table equals GIT_OBJECT_LAYOUT, row by row', () => {
  const { rows, nonKind } = parseDocsTable();

  assert.deepEqual(
    rows.map((r) => r.kind),
    [...GIT_OBJECT_KINDS],
    'the documented table must list every object kind, in the code’s order, and nothing else',
  );
  assert.deepEqual(nonKind, ['os/promotion.yml, os/grants.yml'], 'exactly one documented row is not an object kind: the OS-owned governance metadata');

  for (const row of rows) {
    const layout = GIT_OBJECT_LAYOUT[row.kind as GitObjectKind];
    assert.deepEqual(row.paths, layout.paths, `${row.kind}: the documented path selectors must be the code’s, exactly`);
    assert.equal(row.lane, layout.personalLane, `${row.kind}: the documented personal lane must be the code’s (— means none)`);
    assert.equal(row.writerState, layout.writer.state, `${row.kind}: the documented writer state must be the code’s`);
    const via = layout.writer.state === 'backlog' ? null : layout.writer.via;
    assert.equal(row.writerVia, via, `${row.kind}: the documented writer module must be the code’s`);
  }
});

test('G2: a writer module the table names is a module that exists', () => {
  const { rows } = parseDocsTable();
  const named = rows.filter((r) => r.writerVia).map((r) => r.writerVia as string);
  assert.ok(named.length >= 6, 'the committed kinds each name a writer module');
  for (const module of named) {
    assert.ok(existsSync(join(UI, module)), `docs/components/git.md names ${module}, which does not exist in os-ui/`);
  }
});
