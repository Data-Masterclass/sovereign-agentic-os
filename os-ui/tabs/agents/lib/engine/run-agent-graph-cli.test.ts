/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    The committed `system.yaml` is a RUNNABLE artefact — `scripts/run-agent-graph.mjs`
 *             executes it from a plain checkout (engine rebuild Part F, checklist A4)
 * USER STORY: As an engineer who cloned a domain repository I want the system the OS committed to
 *             run on my laptop with one command — no cluster, no database, no model key — so I can
 *             see where the graph goes and which tools it reaches before I trust it.
 * ARCHITECTURE:
 *   - Drives the CLI as a SUBPROCESS, the way an engineer runs it, against the EXACT
 *     `agents/<slug>/system.yaml` blob the git generator's golden commits. The artefact under
 *     test is therefore the shipped one, not a test-local yaml that could drift from it.
 *   - Asserts the three things A4's `kind` step asserts: it compiles, it reaches END (exit 0),
 *     and it reports a real path through the supervisor's members with their tool calls.
 *   - What this does NOT claim: "runs with LangGraph alone". The CLI uses the OS's own
 *     `buildGraph`; a standalone `graph.ts` + thin runner is still unbuilt (deviation D-8), and
 *     the checklist row A4 says so.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
// `fileURLToPath`, never `URL.pathname`: the checkout path contains spaces, which a URL
// percent-encodes — spawning with the encoded cwd fails as ENOENT.
const osUiRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** The `system.yaml` the OS commits for the shared supervisor team, read from the git golden. */
function committedSystemYaml(): string {
  const golden = JSON.parse(
    readFileSync(new URL('../git/fixtures/shared-supervisor-team.golden.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;
  const path = Object.keys(golden).find((p) => p.endsWith('/system.yaml'));
  assert.ok(path, 'the golden commits no system.yaml');
  return golden[path];
}

test('A4: the committed system.yaml runs from a plain checkout and reaches END', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-agent-graph-'));
  const yaml = join(dir, 'system.yaml');
  writeFileSync(yaml, committedSystemYaml());

  const { stdout } = await run(
    process.execPath,
    ['scripts/run-agent-graph.mjs', yaml, 'Review the revenue numbers and publish the summary.'],
    { cwd: osUiRoot, timeout: 120_000 },
  );

  // Exit 0 is asserted by `execFile` not rejecting; the report says where it went.
  assert.match(stdout, /reachedEnd: true/, `the run did not reach END:\n${stdout}`);
  assert.match(stdout, /engine:\s+langgraph, checkpointer memory/, `not the LangGraph engine:\n${stdout}`);
  const path = /path:\s+(.+)/.exec(stdout)?.[1] ?? '';
  // The supervisor DECIDES its members (A7), so every member appears on the path.
  for (const member of ['lead', 'researcher', 'publisher']) {
    assert.ok(path.includes(member), `'${member}' is missing from the path '${path}'`);
  }
  assert.match(stdout, /tool calls: .*→ /, `no tool reached the stub executor:\n${stdout}`);
});

test('A4: the runner refuses a system it cannot compile rather than reporting a successful run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-agent-graph-bad-'));
  const yaml = join(dir, 'system.yaml');
  writeFileSync(yaml, 'version: "1"\nsystem:\n  name: Broken\n  domain: sales\n');

  await assert.rejects(
    () => run(process.execPath, ['scripts/run-agent-graph.mjs', yaml], { cwd: osUiRoot, timeout: 120_000 }),
    (e: { code?: number; stdout?: string }) => {
      assert.notEqual(e.code, 0, 'an uncompilable system must not exit 0');
      assert.ok(!/reachedEnd: true/.test(e.stdout ?? ''), 'an uncompilable system must not report reaching END');
      return true;
    },
  );
});
