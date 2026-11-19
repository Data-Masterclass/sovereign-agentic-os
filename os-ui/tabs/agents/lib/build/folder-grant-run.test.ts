/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       agents
 * FEATURE:    A run says when a folder grant matched nothing — to the runner, never to the agent
 * USER STORY: As the person running a system whose Files grant points at an empty folder I want
 *             the run report to say "0 files, and 12 are in Domain files /invoices", instead of
 *             an agent that politely reports it found nothing.
 * ARCHITECTURE:
 *   - `resolveFolderGrantsWithWarnings` (`os-tools.ts`) is the run's own resolver; the warning is
 *     derived from the same resolutions the "resolved M of P" trace records, plus the runner's
 *     own listing of the other lane.
 *   - The warning travels in the run report's `warnings` (`withDefinitionWarnings`,
 *     `run-service.ts`). The test also pins where it must NOT appear: the grant brief of the
 *     system prompt names only what the agent is granted.
 *   - The multi-domain case runs the REAL loader (`serverScopedItemsLoader`) with the Files
 *     listing injected (a tab's test may not import another tab's store): a runner who belongs
 *     to two domains resolves a Domain folder grant from their Domain lane, by folder.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CurrentUser } from '@core/kernel/auth';
import { parseSystem } from '@tabs/agents/lib/system-schema';
import {
  resolveFolderGrants, resolveFolderGrantsWithWarnings, serverScopedItemsLoader, type ScopedItemsLoader, type FileLister,
} from '@tabs/agents/lib/build/os-tools';
import { grantScopeBrief } from '@tabs/agents/lib/build/grant-scope';
import { outputsBrief } from '@tabs/agents/lib/output-tools';

const sysWith = (files: unknown[], extra: Record<string, unknown> = {}) =>
  parseSystem({
    version: '1',
    system: { name: 'Invoice desk', domain: 'finance', visibility: 'Personal' },
    entrypoint: 'a',
    grants: { tools: ['list_files', 'get_file'], files },
    agents: [{ id: 'a', role: 'agent', agent_md: '', memory_md: '' }],
    ...extra,
  });

const user: CurrentUser = { id: 'u1', name: 'U', role: 'admin', domains: ['sales', 'finance'], allDomains: ['sales', 'finance'], activeDomain: null };
const noTrace = { trace: async () => undefined } as unknown as Parameters<typeof resolveFolderGrantsWithWarnings>[3];

/** Twelve invoices in Domain /invoices, nothing in My files — the reported situation. */
const reportedLoad: ScopedItemsLoader = async (_kind, scope) =>
  scope === 'domain' ? Array.from({ length: 12 }, (_, i) => ({ id: `f${i}`, folder: '/invoices' })) : [];

test('RUN WARNING: a My-files grant that matches nothing is reported, with where the files are', async () => {
  const sys = sysWith([{ folder: { path: '/', scope: 'personal' }, capability: 'Read' }]);
  const { warnings } = await resolveFolderGrantsWithWarnings(user, sys, 'sys1', { ...noTrace!, load: reportedLoad });
  assert.deepEqual(warnings, ['The grant on all of My files currently contains 0 files. 12 files are in Domain files.']);

  const named = sysWith([{ folder: { path: '/invoices', scope: 'personal' }, capability: 'Read' }]);
  const r2 = await resolveFolderGrantsWithWarnings(user, named, 'sys1', { ...noTrace!, load: reportedLoad });
  assert.deepEqual(r2.warnings, ['The grant on /invoices in My files currently contains 0 files. 12 files are in Domain files /invoices.']);
});

test('RUN WARNING: none when the grant matches, and none for a declared output folder that is still empty', async () => {
  const ok = sysWith([{ folder: { path: '/invoices', scope: 'domain' }, capability: 'Read' }]);
  assert.deepEqual((await resolveFolderGrantsWithWarnings(user, ok, 'sys1', { ...noTrace!, load: reportedLoad })).warnings, []);

  const out = sysWith(
    [{ folder: { path: '/reports', scope: 'personal' }, capability: 'Write-bounded' }],
    { outputs: [{ kind: 'files', name: 'Report', folder: { path: '/reports', scope: 'personal' } }] },
  );
  assert.deepEqual((await resolveFolderGrantsWithWarnings(user, out, 'sys1', { ...noTrace!, load: reportedLoad })).warnings, []);
});

test('WHAT THE AGENT IS TOLD is unchanged: the prompt names its grant, not the files outside it', async () => {
  const sys = sysWith([{ folder: { path: '/', scope: 'personal' }, capability: 'Read' }]);
  const { system } = await resolveFolderGrantsWithWarnings(user, sys, 'sys1', { ...noTrace!, load: reportedLoad });
  const brief = grantScopeBrief(system);
  assert.match(brief, /files: only files in \/ \(My files, read-only\)/);
  assert.doesNotMatch(brief, /Domain files/);
  assert.doesNotMatch(brief, /12 files|0 files/);
  assert.equal(outputsBrief(system), '');
  // The resolved system is the same one a run without warnings would execute.
  assert.deepEqual(system, (await resolveFolderGrants(sys, reportedLoad)).system);
});

test('MULTI-DOMAIN: a runner in two domains resolves a Domain folder grant to the system\'s domain files', async () => {
  // What the Files store hands a runner who belongs to sales AND finance (with no single active
  // domain, every membership is listed — `tabs/files/lib/domain-scope.test.ts` pins that side).
  const listFiles: FileLister = async (principal) => {
    assert.deepEqual(principal.domains, ['sales', 'finance'], 'the listing is asked for as the runner, with all their domains');
    return {
      mine: [{ id: 'f_mine', folder: '/invoices' }],
      domain: [
        { id: 'f_fin1', folder: '/invoices' },
        { id: 'f_fin2', folder: '/invoices/2026' },
        { id: 'f_fin_other', folder: '/contracts' },
        { id: 'f_sales', folder: '/pipeline' },
      ],
    };
  };
  const load = serverScopedItemsLoader(user, { listFiles });

  const sys = sysWith([{ folder: { path: '/invoices', scope: 'domain' }, capability: 'Read' }]);
  const { resolutions } = await resolveFolderGrants(sys, load);
  assert.equal(resolutions.length, 1);
  assert.deepEqual([...resolutions[0].ids].sort(), ['f_fin1', 'f_fin2']);

  // …and the same path in the My lane resolves the runner's private file only.
  const mine = await resolveFolderGrants(sysWith([{ folder: { path: '/invoices', scope: 'personal' }, capability: 'Read' }]), load);
  assert.deepEqual(mine.resolutions[0].ids, ['f_mine']);
});
