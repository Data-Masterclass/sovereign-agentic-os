/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    i18n wave 4 — report, alert and data-quality notices are written in the RECIPIENT's language
 * USER STORY: As a German recipient I read "Alarm ausgelöst: …" in my bell, while an English recipient reads exactly
 *             the text the OS always wrote.
 * ARCHITECTURE: the saved-language lookup (`@core/prefs/locale`) is mocked per user; the notices are read back from
 *   the real in-app store.
 */
import { test, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const LOCALES: Record<string, string> = { greta: 'de' };
mock.module('@core/prefs/locale', {
  namedExports: {
    getUserLocale: async (id: string) => LOCALES[id] ?? 'en',
    getUserLocaleFresh: async (id: string) => LOCALES[id] ?? 'en',
    getSavedLocale: async (id: string) => LOCALES[id] ?? null,
  },
});
const { deliverAlert, deliverReport, deliverDqAlert } = await import('@tabs/dashboards/lib/delivery');
const { __resetNotifications, listNotifications } = await import('@core/notifications/store');

const report = { dashboardId: 'sales-overview', cadence: 'weekly' as const, channel: 'in_app' as const };
const rule = { member: 'Sales.revenue' };
// A breached evaluation as the metrics alert rule returns it (a tab may not import another tab — GLUE-9).
const breached = (value: number) => ({ breached: true, value, notifications: [{ channel: 'in_app' as const, message: `Alert: Sales.revenue below 50000` }], agentRun: null });
const SENT = Date.parse('2026-11-27T10:00:00.000Z');

afterEach(() => __resetNotifications());

test('an English recipient gets the report notice byte-identical to before', async () => {
  await deliverReport(report as never, { userId: 'amir' }, SENT);
  const [n] = listNotifications('amir');
  assert.equal(n.title, 'Report notice: sales-overview');
  assert.equal(n.body, 'A notice for dashboard "sales-overview" was posted by hand. Open the dashboard to see its current data.\nPosted 2026-11-27T10:00:00.000Z in-app.');
});

test('a German recipient gets the report notice in German (time stays ISO)', async () => {
  await deliverReport(report as never, { userId: 'greta' }, SENT);
  const [n] = listNotifications('greta');
  assert.equal(n.title, 'Bericht-Hinweis: sales-overview');
  assert.match(n.body, /Ein Hinweis zum Dashboard „sales-overview“/);
  assert.match(n.body, /Gesendet 2026-11-27T10:00:00\.000Z in der App\./);
});

test('alert: English unchanged, German translated with a German number', async () => {
  const ev = breached(42000.5);
  await deliverAlert(ev, rule.member, { userId: 'amir' });
  await deliverAlert(ev, rule.member, { userId: 'greta' });
  const [en] = listNotifications('amir');
  const [de] = listNotifications('greta');
  assert.equal(en.title, 'Alert fired: Sales.revenue');
  assert.match(en.body, /\nCurrent value: 42000\.5\.$/);
  assert.equal(de.title, 'Alarm ausgelöst: Sales.revenue');
  assert.match(de.body, /\nAktueller Wert: 42\.000,5\.$/);
});

test('data-quality notice: no language is English as before; German when the caller passes it', () => {
  const input = { datasetName: 'orders', healthScore: 62.5, failingLabels: ['not null: id', 'unique: id'] };
  deliverDqAlert(input, { userId: 'amir' });
  deliverDqAlert(input, { userId: 'greta' }, 'de');
  const [en] = listNotifications('amir');
  const [de] = listNotifications('greta');
  assert.equal(en.title, 'Data quality alert: orders');
  assert.equal(en.body, 'Quality checks failed for "orders".\nHealth score: 62.5/100.\nFailing: not null: id, unique: id.');
  assert.equal(de.title, 'Datenqualitätsalarm: orders');
  assert.equal(de.body, 'Qualitätsprüfungen für „orders“ fehlgeschlagen.\nGesundheitswert: 62.5/100.\nFehlgeschlagen: not null: id, unique: id.');
  deliverDqAlert({ ...input, healthScore: null, failingLabels: [] }, { userId: 'amir' });
  assert.equal(listNotifications('amir')[0].body, 'Quality checks failed for "orders".\nHealth score: unknown.');
});
