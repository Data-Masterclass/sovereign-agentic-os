/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The honest-documentation TRIPWIRE (night-2 S1, decision D22(c))
 * USER STORY: As an IT reviewer I must not find a described pipeline that does not exist. Every
 *             scaffolded app's README and Dockerfile used to tell the user "built by Sovereign
 *             Agentic OS CI → Harbor → Argo CD" and "Argo CD syncs it to https://<slug>.<domain>";
 *             the software lib README described Forgejo, Harbor, Argo CD and two modules
 *             (`build-service.ts`, `ci-repair.ts`) that are NOT IN THE TREE. A reviewer who greps
 *             for them and finds nothing stops believing the parts that are true — the deploy
 *             gate, the identity model, the NetworkPolicies. This test makes the purge permanent.
 * ARCHITECTURE:
 *   - A grep-shaped assertion over the SHIPPED tree areas the Software tab owns, plus the chart
 *     values and the kernel config. CHANGELOG.md, `licenses/**`, `THIRD-PARTY-LICENSES.md`,
 *     `deploy/**` and `docs/superpowers/plans/**` are DELIBERATE historical records and are out
 *     of scope — a tripwire that forbade naming a retired component in a changelog would be
 *     dishonest in the other direction.
 *   - An allowance list carries the few places that may name a component in order to DENY it
 *     ("there is no Argo CD"), matched as a whole line so a re-introduced claim still fails.
 *   - It also asserts the two modules the old README named really are absent, so the README and
 *     the tree can never disagree again.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** os-ui/ (this file lives at os-ui/tabs/software/lib/). */
const OS_UI = join(import.meta.dirname, '..', '..', '..');
const REPO = join(OS_UI, '..');

/** Components that do not exist in this stack. Naming one as a FACT is the defect. */
const FORBIDDEN = [
  'forgejo',
  'harbor',
  'argo cd',
  'argocd',
  'kaniko',
  'build-service.ts',
  'ci-repair.ts',
  'gitea_admin',
];

/** Files whose every line is scanned. */
const SCAN_ROOTS = [
  join(OS_UI, 'tabs', 'software'),
  // REVIEW M-6: the kernel and the shared infra describe the stack too, and they carried live
  // false claims (`core/policy/effects.ts`, `core/policy/README.md`, `core/infra/README.md`,
  // `core/kernel/README.md`), as did a USER-VISIBLE monitoring string and the kind cluster config.
  join(OS_UI, 'core'),
  join(OS_UI, 'tabs', 'monitoring', 'lib', 'adapters', 'system-health.ts'),
  join(REPO, 'kind-config.yaml'),
  join(OS_UI, 'tabs', 'admin', 'ui', 'OverviewHealth.tsx'),
  join(OS_UI, 'tabs', 'admin', 'lib', 'components-extra.ts'),
  join(OS_UI, 'tabs', 'admin', 'mcp', 'discovery-waveb-tools.ts'),
  join(OS_UI, 'core', 'kernel', 'config.ts'),
  join(REPO, 'charts', 'sovereign-agentic-os', 'values.yaml'),
  join(REPO, 'values.stackit-managed.yaml'),
];

const SCAN_EXT = ['.ts', '.tsx', '.md', '.yaml', '.yml'];

/** Tests are not shipped documentation — and several of them assert a component's ABSENCE. */
const isTest = (p: string) => p.endsWith('.test.ts') || p.endsWith('.test.tsx');

/**
 * Lines that are allowed to name a retired component BECAUSE THEY DENY IT. Each entry is a
 * substring of the whole trimmed line; a re-introduced positive claim will not match one.
 */
const ALLOWED_LINE_FRAGMENTS = [
  'There is **no Forgejo, no Harbor, no Argo CD, no image builder and',
  'no CI runner** in the Sovereign Agentic OS, and no `build-service.ts` / `ci-repair.ts`',
  'GitOps controller (no Argo CD, no Flux) in this stack, so nothing reverts drift',
  '`monitoring-and-healing.md`\'s L1 Kubernetes self-heal — there is no L2 GitOps layer);',
  '`softwareBuildNamespace` and `kanikoImage`. Its implementation was deleted with the',
  'kpack/CNB — Kaniko is archived upstream (read-only since June 2025, no CVE fixes) and',
  // DESIGN.md records WHY the image/pod bet was abandoned — a post-mortem, not a claim.
  'Most Software-build fragility is accidental, downstream of two bets:',
  // This test file itself names them in order to forbid them.
  // The chart DENIES the component in the same line that names its (disabled) key. The bare
  // `argocd:` fragment used to be allowlisted on its own, which would have waved through ANY
  // line containing it; it is now the full line (review M-6).
  'enabled: false   # Argo CD is not part of the stack',
  // `.forgejo/` named in order to REFUSE a push of it.
  "const FORBIDDEN_PREFIXES = ['.app/', '.forgejo/', '.github/', '.git/', '.gitea/', 'node_modules/'] as const;",
  // Denials added by the night-2 purge.
  'controller and no image builder in this stack), grant access (policy compiler →',
  'no GitOps controller, so configuration drift is not reverted automatically.`,',
  '# uses it. install.sh creates the cluster with `--config kind-config.yaml`.',
  // A factual pointer at files that really are in `deploy/` (out of scope, historical).
  '# Secrets from Secrets Manager — see deploy/argocd/secrets/externalsecrets.yaml).',
];

function filesUnder(path: string): string[] {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return SCAN_EXT.some((e) => path.endsWith(e)) && !isTest(path) ? [path] : [];
  const out: string[] = [];
  for (const entry of readdirSync(path)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    out.push(...filesUnder(join(path, entry)));
  }
  return out;
}

/**
 * Whole lines that are allowed, matched by EXACT equality on the trimmed line (review M-6). A
 * bare substring like `argocd:` would have waved through any line containing it; the chart's
 * disabled-key line is exactly that string and nothing more, so equality is the right test.
 */
const ALLOWED_EXACT_LINES = ['argocd:'];

function allowed(line: string, file: string): boolean {
  const t = line.trim();
  if (file.endsWith(`lib${sep}honest-docs.test.ts`)) return true;
  if (ALLOWED_EXACT_LINES.includes(t)) return true;
  return ALLOWED_LINE_FRAGMENTS.some((f) => t.includes(f));
}

test('TRIPWIRE: no shipped file claims a component that does not exist', () => {
  const offences: string[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of filesUnder(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const lower = line.toLowerCase();
        const hit = FORBIDDEN.find((f) => lower.includes(f));
        if (hit && !allowed(line, file)) {
          offences.push(`${relative(REPO, file)}:${i + 1}: names '${hit}' — ${line.trim().slice(0, 120)}`);
        }
      });
    }
  }
  assert.deepEqual(
    offences,
    [],
    `These shipped files describe components this stack does not have. Delete the claim (do not "fix" it):\n${offences.join('\n')}`,
  );
});

test('TRIPWIRE: the two modules the old README named are really absent', () => {
  for (const missing of ['build-service.ts', 'ci-repair.ts']) {
    assert.equal(
      existsSync(join(OS_UI, 'tabs', 'software', 'lib', missing)),
      false,
      `${missing} does not exist — no document may describe it`,
    );
  }
});

test('TRIPWIRE: no scaffold seeds a forge CI workflow or a registry login', () => {
  const scaffolds = filesUnder(join(OS_UI, 'tabs', 'software', 'lib', 'scaffolds'));
  assert.ok(scaffolds.length >= 5, 'the scaffolds are being scanned');
  for (const file of scaffolds) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('.forgejo/'), `${relative(REPO, file)} seeds no .forgejo/ workflow`);
    assert.ok(!text.includes('docker login'), `${relative(REPO, file)} seeds no registry login`);
    assert.ok(!text.includes('REGISTRY_PASS'), `${relative(REPO, file)} references no CI registry secret`);
  }
});

test('TRIPWIRE: the chart ships NO default runner image — an empty default fails closed', () => {
  const values = readFileSync(join(REPO, 'charts', 'sovereign-agentic-os', 'values.yaml'), 'utf8');
  assert.match(values, /runnerImage: ""/, 'softwareRunner.runnerImage is empty by default');
  assert.ok(!/whoami/i.test(values), 'no third-party placeholder container is a chart default');
});
