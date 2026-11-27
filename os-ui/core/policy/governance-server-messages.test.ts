/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    i18n wave 4 — the governance area's coded server messages keep their English byte-for-byte
 * USER STORY: As a German admin I read "Freigabe nicht gefunden" or "Kostenlimit überschritten", while API and MCP
 *             clients, logs and the audit trail keep reading exactly the English the OS always sent.
 * ARCHITECTURE: every (english, code, params) the governance, approvals, egress, lifecycle, monitoring and prefs
 *   routes (and the ladder's refusals) emit, rendered through the on-disk catalogs: `server.<code>` in `en` must equal
 *   the English, and every language has the code. Monitoring alerts: tabs/monitoring/lib/alerts-i18n.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorBody, type ServerParams } from '@core/kernel/server-message';
import { assertServerEnglish, serverText } from '@core/testing/server-message';
import { approvalNotice } from '@core/policy/approval-notice';
import { CATALOG_LOCALES, catalogText } from '@core/testing/catalog-text';
import { activeConditions } from '@core/infra/drive-sync-health';

const ROUTE_MESSAGES: [string, string, ServerParams?][] = [
  ['Setting a cap needs a Builder or Admin', 'governance.capNeedsBuilder'],
  ['subject + non-negative numeric limit required', 'governance.capLimitRequired'],
  ['Builders and Domain admins may only cap their own domain', 'governance.capOwnDomainOnly'],
  ['subject + numeric amount required', 'governance.costCheckRequired'],
  ['Viewing the policy plane requires the policy.view right (Builder or Admin)', 'governance.policyViewNeedsRight'],
  ['Overriding policy requires an Administrator', 'governance.overrideNeedsAdmin'],
  ['principal + tool required', 'governance.overrideFieldsRequired'],
  ['Seeding the demo queue needs a Builder or Admin', 'governance.seedNeedsBuilder'],
  ['Could not reach OPA: connect ECONNREFUSED', 'governance.opaUnreachable', { detail: 'connect ECONNREFUSED' }],
  ['locale must be one of en, de, fr, es, it, pl, cs', 'governance.prefs.localeInvalid', { locales: 'en, de, fr, es, it, pl, cs' }],
  ['Policy did not allow saving your language (or the policy engine did not answer). Nothing was changed.', 'policy.languageSaveDenied'],
  ['Your language could not be saved right now. Try again in a moment.', 'governance.prefs.languageSaveUnavailable'],
  ['Unknown surface: "nowhere"', 'governance.prefs.unknownSurface', { surface: 'nowhere' }],
  ['surface must be "studio" or "run"', 'governance.prefs.viewSurfaceInvalid'],
  ['Approval not found', 'approvals.notFound'],
  ['Out of scope', 'approvals.outOfScope'],
  ['Already approved', 'approvals.alreadyDecided', { status: 'approved' }],
  ['Already withdrawn', 'approvals.alreadyDecided', { status: 'withdrawn' }],
  ['This item needs an Administrator', 'approvals.needsAdmin'],
  ['This item needs a Domain admin of sales', 'approvals.needsRoleOfDomain', { role: 'Domain admin', domain: 'sales' }],
  ['This item is already being applied or was decided', 'approvals.alreadyApplying'],
  ['Could not decide (raced?)', 'approvals.raced'],
  ['Could not decide', 'approvals.couldNotDecide'],
  ['Effect failed: publisher unreachable', 'approvals.effectFailed', { detail: 'publisher unreachable' }],
  ['Requesting egress requires a Builder or Administrator', 'egress.needsBuilder'],
  ['A host or endpoint is required', 'egress.hostRequired'],
  ['Egress request not found', 'egress.notFound'],
  ['kind and id are required', 'lifecycle.kindIdRequired'],
  ["action must be 'go_live' or 'retire'", 'lifecycle.actionInvalid'],
  ['unknown kind: "widget"', 'lifecycle.unknownKind', { kind: 'widget' }],
  ['Artifact not found', 'lifecycle.artifactNotFound'],
  ['Only the dashboard owner can request its promotion', 'lifecycle.ownerOnlyRequest', { kind: 'dashboard' }],
  ['This dashboard is already promoted', 'lifecycle.alreadyPromoted', { kind: 'dashboard' }],
  ["Certification is filed by a Builder/Domain-admin in the connection's domain (sales)", 'lifecycle.certifyFiledBy', { kind: 'connection', domain: 'sales' }],
  ['This app is already certified', 'lifecycle.alreadyCertified', { kind: 'app' }],
  ['Promote this app to the domain before certifying', 'lifecycle.promoteBeforeCertify', { kind: 'app' }],
  ['Only the knowledge owner can promote it directly — the owner must file request_promotion first, then a domain admin approves it.', 'lifecycle.ownerMustRequest', { kind: 'knowledge' }],
  ['This artifact is already personal — nothing to revoke', 'lifecycle.alreadyPersonal', { kind: 'artifact' }],
  ['view must be agents, data, platform, files, knowledge, kpis or dashboards', 'monitoring.panelViewInvalid'],
  ['missing id', 'monitoring.missingId'],
  ['not found or out of scope', 'monitoring.notFoundOrOutOfScope'],
];

test('every governance-area route message renders to its exact English and exists in every language', () => {
  for (const [english, code, params] of ROUTE_MESSAGES) assertServerEnglish(errorBody(english, code, params));
});

test('German renders the translation, with the status word translated', () => {
  assert.equal(serverText('approvals.alreadyDecided', { status: 'approved' }, 'de'), 'Bereits freigegeben');
  assert.equal(serverText('approvals.notFound', undefined, 'de'), 'Freigabe nicht gefunden');
});

test('drive conditions carry codes whose English equals their text', () => {
  const now = Date.parse('2026-11-27T12:00:00Z');
  const base = { createdAt: '2026-11-27T08:00:00Z', paused: false };
  const cases = [
    activeConditions({ ...base, runs: [{ ok: false, at: '2026-11-27T11:00:00Z', endedAt: '2026-11-27T11:00:01Z', error: 'quota exceeded' }] } as never, 'needs-reconnect', now, 30 * 60_000),
    activeConditions({ ...base, runs: [{ ok: false, at: '2026-11-27T11:00:00Z', endedAt: '2026-11-27T11:00:01Z' }] } as never, 'ok' as never, now, 30 * 60_000),
    activeConditions({ ...base, runs: [{ ok: true, at: '2026-11-27T09:00:00Z', endedAt: '2026-11-27T09:00:00Z' }] } as never, 'ok' as never, now, 30 * 60_000),
  ].flat();
  assert.ok(cases.some((c) => c.kind === 'failed') && cases.some((c) => c.kind === 'lag') && cases.some((c) => c.kind === 'reconnect'));
  for (const c of cases) assertServerEnglish({ error: c.text, code: c.code, params: c.params });
});

test('the approval notice renders its English through common.approvalNotice and translates per language', () => {
  for (const where of [{ scope: 'domain', approverRole: 'domain_admin' }, { scope: 'tenant', approverRole: 'admin' }] as const) {
    for (const kind of ['dataset', 'agent system', 'workflow']) {
      const n = approvalNotice({ id: 'ap1', domain: 'sales', ...where }, kind, null);
      assert.equal(catalogText('common', { key: n.messageKey, args: n.messageArgs }, 'en'), n.message);
      for (const l of CATALOG_LOCALES) assert.ok(catalogText('common', { key: n.messageKey, args: n.messageArgs }, l).trim().length > 0, l);
    }
  }
  const de = approvalNotice({ id: 'ap1', domain: 'sales', scope: 'domain', approverRole: 'domain_admin' }, 'dataset', null);
  assert.equal(catalogText('common', { key: de.messageKey, args: de.messageArgs }, 'de'),
    'Anfrage gestellt — dieser Datensatz wartet auf die Freigabe für die Domäne. Gib sie unter Richtlinien & Freigaben frei.');
});
