/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * TAB:        knowledge
 * FEATURE:    WP-50 EJECT TEST (design 11 A29 row d, AT-f) — the committed `knowledge/` tree is a
 *             conformant OKF v0.3 bundle by the OKF project's OWN reference validator
 * USER STORY: As an engineer leaving the OS I want `git archive HEAD knowledge/` from my domain
 *             repository to pass `validate.py --strict`, so any OKF consumer can read it.
 * ARCHITECTURE:
 *   - The validator is upstream `validate.py`, vendored unmodified and pinned by commit + sha256
 *     (`os-ui/scripts/okf/pin.json`); the test first checks the file's sha256 against the pin, so a
 *     locally edited validator cannot pass. It runs in the pinned Python image with only PyYAML, as
 *     `validate.py` declares. Runs only with `WP50_EJECT=1` (CI job `artifacts-eject`).
 *   - The bundle comes from the REAL commit path (`commitKnowledge` into a temp repo) and is read
 *     back from git at the commit sha — the files an engineer would clone.
 *   - NEGATIVE TWINS (must fail the same validator): a concept file without frontmatter, and a
 *     sub-folder `index.md` that carries frontmatter (OKF E004).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listTree, readBlob } from '@core/infra/git-store';
import { commitKnowledge, __setKnowledgeGitForTests } from '@tabs/knowledge/lib/git/commit';
import { manual, workflowRecord } from '@tabs/knowledge/lib/git/fixtures';

const ENABLED = process.env.WP50_EJECT === '1';
const SKIP = ENABLED ? false : 'set WP50_EJECT=1 to run the OKF reference validator in its container (CI job artifacts-eject)';
const OKF_DIR = join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'okf');
type Pin = { sha256: string; pythonImage: string; pyyaml: string; commit: string };
const pin = (): Pin => JSON.parse(readFileSync(join(OKF_DIR, 'pin.json'), 'utf8')) as Pin;

type Finding = { code: string; level: string; path: string; message: string };
function validate(bundleDir: string): { code: number; findings: Finding[]; raw: string } {
  const p = pin();
  const tools = mkdtempSync(join(tmpdir(), 'wp50-okf-tools-'));
  cpSync(join(OKF_DIR, 'validate.py'), join(tools, 'validate.py'));
  chmodSync(tools, 0o755);
  const r = spawnSync(
    'docker',
    [
      'run', '--rm', '-v', `${tools}:/okf:ro`, '-v', `${bundleDir}:/bundle:ro`, p.pythonImage, 'sh', '-c',
      `pip install -q --disable-pip-version-check --root-user-action=ignore pyyaml==${p.pyyaml} >/dev/null && python3 -I /okf/validate.py /bundle --strict --json`,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  rmSync(tools, { recursive: true, force: true });
  const raw = `${r.stdout ?? ''}`;
  let findings: Finding[] = [];
  try {
    const parsed = JSON.parse(raw) as { findings?: Finding[] } | Finding[];
    findings = Array.isArray(parsed) ? parsed : (parsed.findings ?? []);
  } catch {
    throw new Error(`validate.py did not print JSON (exit ${r.status}): ${raw.slice(0, 1000)} ${r.stderr ?? ''}`);
  }
  return { code: r.status ?? 1, findings, raw };
}

async function bundleFromGit(): Promise<{ dir: string; work: string; sha: string }> {
  const work = mkdtempSync(join(tmpdir(), 'wp50-okf-'));
  const reposDir = join(work, 'repos');
  const res = await commitKnowledge('sales', { id: 'eject@example.com', name: 'Eject' }, { action: 'publish workflow' }, {
    reposDir, mirror: false, captured: { workflows: [workflowRecord()], manual: manual() },
  });
  assert.ok(res?.changed);
  const dir = join(work, 'bundle');
  for (const e of await listTree('sales', res!.sha, { reposDir })) {
    if (!e.path.startsWith('knowledge/')) continue;
    const out = join(dir, e.path.slice('knowledge/'.length));
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, await readBlob('sales', res!.sha, e.path, { reposDir }));
  }
  chmodSync(dir, 0o755);
  return { dir, work, sha: res!.sha };
}

test('the pinned validator is the upstream file, byte for byte', () => {
  const sum = createHash('sha256').update(readFileSync(join(OKF_DIR, 'validate.py'))).digest('hex');
  assert.equal(sum, pin().sha256);
});

test('EJECT: the committed knowledge/ tree passes the OKF reference validator with --strict', { skip: SKIP, timeout: 600_000 }, async () => {
  __setKnowledgeGitForTests(true);
  const b = await bundleFromGit();
  try {
    const v = validate(b.dir);
    console.log(`[wp50-eject] okf validate.py@${pin().commit.slice(0, 12)} --strict on knowledge/ at ${b.sha.slice(0, 12)}: exit ${v.code}, ${v.findings.length} finding(s)`);
    assert.deepEqual(v.findings.filter((f) => f.level !== 'info'), [], v.raw);
    assert.equal(v.code, 0, v.raw);
  } finally {
    __setKnowledgeGitForTests(null);
    rmSync(b.work, { recursive: true, force: true });
  }
});

test('EJECT NEGATIVE TWINS: the same validator rejects a concept without frontmatter and a sub-index with frontmatter', { skip: SKIP, timeout: 600_000 }, async () => {
  __setKnowledgeGitForTests(true);
  const b = await bundleFromGit();
  try {
    writeFileSync(join(b.dir, 'workflows', 'bank-submission', 'tacit.md'), 'Just text, no frontmatter.\n');
    const noFront = validate(b.dir);
    assert.notEqual(noFront.code, 0, 'a concept without frontmatter must fail --strict');
    assert.ok(noFront.findings.some((f) => f.code === 'W120'), noFront.raw);

    writeFileSync(join(b.dir, 'workflows', 'index.md'), '---\ntitle: nope\n---\n# Workflows\n');
    const subIndex = validate(b.dir);
    assert.ok(subIndex.findings.some((f) => f.code === 'E004'), subIndex.raw);
  } finally {
    __setKnowledgeGitForTests(null);
    rmSync(b.work, { recursive: true, force: true });
  }
});
