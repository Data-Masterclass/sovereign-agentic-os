/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Declared app actions + the four-layer fail-closed intersection (night-2 S8)
 * USER STORY: As a domain admin my consent must be REQUIRED before my domain's agents can use a
 *             vibe-engineered app's actions, and a writing action must be HELD, not executed.
 * ARCHITECTURE: Pure unit test — the parser and the intersection have no I/O.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ACTIONS_FILE,
  ACTION_SCOPES,
  parseAppActions,
  authorizeDeclaredAction,
  declaredActionTools,
  withinDeclaredScopes,
  type AdoptionPort,
  type AppAction,
} from './app-actions.ts';

const yml = `
# The app's agent-callable surface.
actions:
  - name: list_invoices
    description: List invoices the caller may see.
    write: false
    scopes: [records, data]
    input:
      status: string
  - name: approve_invoice
    description: Approve one invoice.
    write: true
    scopes: [records]
    input:
      id: string
`;

const files = (content: string) => [{ path: ACTIONS_FILE, content }];

test('parseAppActions: no actions.yml is not an error — an app need not declare any', () => {
  assert.deepEqual(parseAppActions([]), { actions: [], issues: [] });
  assert.deepEqual(parseAppActions([{ path: 'app.yaml', content: 'name: X\n' }]), { actions: [], issues: [] });
});

test('parseAppActions: a well-formed declaration becomes typed actions', () => {
  const { actions, issues } = parseAppActions(files(yml));
  assert.deepEqual(issues, []);
  assert.equal(actions.length, 2);
  assert.deepEqual(actions[0], {
    name: 'list_invoices',
    description: 'List invoices the caller may see.',
    write: false,
    scopes: ['records', 'data'],
    input: { status: 'string' },
  });
  assert.equal(actions[1].write, true, 'a write is declared as a write');
  assert.deepEqual(declaredActionTools(actions), [
    { name: 'list_invoices', description: 'List invoices the caller may see.', write: false },
    { name: 'approve_invoice', description: 'Approve one invoice.', write: true },
  ]);
});

test('parseAppActions: a malformed entry is DROPPED with a machine-actionable issue, never half-declared', () => {
  const { actions, issues } = parseAppActions(
    files(`
actions:
  - name: Bad-Name
    scopes: [records]
  - name: no_scopes
  - name: bad_scope
    scopes: [records, secrets]
  - name: list_ok
    scopes: [records]
  - name: list_ok
    scopes: [records]
`),
  );
  assert.deepEqual(actions.map((a) => a.name), ['bad_scope', 'list_ok'], 'only the usable ones survive');
  const reasons = issues.map((i) => i.reason);
  assert.ok(reasons.some((r) => /is not a valid action name/.test(r)));
  assert.ok(reasons.some((r) => /declares no valid scope/.test(r)));
  assert.ok(reasons.some((r) => /unknown scope\(s\): secrets/.test(r)));
  assert.ok(reasons.some((r) => /declared twice/.test(r)));
  for (const i of issues) {
    assert.match(i.path, /^actions\.yml#actions\[\d+\]/, 'the issue names WHERE');
    assert.ok(i.fix.length > 10, 'and HOW to fix it');
  }
});

const ACTIONS = parseAppActions(files(yml)).actions;
const adopted: AdoptionPort = { adopted: () => true };
const notAdopted: AdoptionPort = { adopted: () => false };
const ctx = {
  declared: ACTIONS,
  capability: ['list_invoices', 'approve_invoice'],
  granted: ['list_invoices', 'approve_invoice'],
  domain: 'eng',
  appExposureId: 'app-invoices',
};

test('the intersection ALLOWS only when all four layers agree', () => {
  const ok = authorizeDeclaredAction('list_invoices', ctx, adopted);
  assert.equal(ok.effect, 'allow');
  assert.match(ok.effect === 'allow' ? ok.reason : '', /capability ∩ declaration ∩ adoption ∩ grant/);
});

test('each layer refuses on its own, and the refusal NAMES the layer', () => {
  const undeclared = authorizeDeclaredAction('delete_everything', ctx, adopted);
  assert.equal(undeclared.effect, 'deny');
  assert.equal(undeclared.effect === 'deny' ? undeclared.layer : '', 'declaration');
  assert.match(undeclared.effect === 'deny' ? undeclared.reason : '', /actions\.yml/);

  const noCapability = authorizeDeclaredAction('list_invoices', { ...ctx, capability: [] }, adopted);
  assert.equal(noCapability.effect === 'deny' ? noCapability.layer : '', 'capability');

  const noAdoption = authorizeDeclaredAction('list_invoices', ctx, notAdopted);
  assert.equal(noAdoption.effect === 'deny' ? noAdoption.layer : '', 'adoption');
  assert.match(
    noAdoption.effect === 'deny' ? noAdoption.reason : '',
    /domain administrator must adopt/,
    'it says WHO must consent',
  );

  const noGrant = authorizeDeclaredAction('list_invoices', { ...ctx, granted: [] }, adopted);
  assert.equal(noGrant.effect === 'deny' ? noGrant.layer : '', 'grant');
});

test('a WRITE action is HELD under the reads-on/writes-off preset — never auto-executed', () => {
  const held = authorizeDeclaredAction('approve_invoice', ctx, adopted);
  assert.equal(held.effect, 'requires_approval');
  assert.match(held.effect === 'requires_approval' ? held.reason : '', /held for human approval/);
  // Only an explicit opt-out of the preset allows it outright (a Builder-approved envelope).
  const allowed = authorizeDeclaredAction('approve_invoice', { ...ctx, readsOnWritesOff: false }, adopted);
  assert.equal(allowed.effect, 'allow');
  // And the hold still requires the other three layers — a revoked adoption denies first.
  assert.equal(authorizeDeclaredAction('approve_invoice', ctx, notAdopted).effect, 'deny');
});

test('an adoption is per DOMAIN and per ACTION — the port is asked with all three', () => {
  const seen: string[] = [];
  const port: AdoptionPort = {
    adopted: (exposure, domain, action) => {
      seen.push(`${exposure}|${domain}|${action}`);
      return false;
    },
  };
  authorizeDeclaredAction('list_invoices', ctx, port);
  assert.deepEqual(seen, ['app-invoices|eng|list_invoices']);
});

test('withinDeclaredScopes: an action may never touch what it did not declare', () => {
  const action = ACTIONS[0] as AppAction;
  assert.equal(withinDeclaredScopes(action, ['records']), true);
  assert.equal(withinDeclaredScopes(action, ['records', 'data']), true);
  assert.equal(withinDeclaredScopes(action, ['knowledge']), false);
  assert.equal(withinDeclaredScopes(action, []), true, 'touching nothing is in scope');
  assert.deepEqual([...ACTION_SCOPES], ['records', 'data', 'knowledge', 'metrics', 'files']);
});
