/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read OPA's decision logs and status reports where the design ships them: VictoriaLogs
 * USER STORY: As AT-a…AT-e I want "the policy allowed files.create / denied ImpersonateUser" to be
 *             OPA's own decision log entry with its decision_id, not an OS audit row.
 * ARCHITECTURE:
 *   - OPA decision log events (decision_id, path, input, result, bundles.<name>.revision,
 *     timestamp, labels) and status events (bundles.<name>.active_revision) are written to the
 *     console (decision_logs.console / status.console), collected by the OTel Collector and
 *     stored in VictoriaLogs (WP-05, WP-06).
 *     OPA docs: https://www.openpolicyagent.org/docs/management-decision-logs ,
 *               https://www.openpolicyagent.org/docs/management-status
 *   - VictoriaLogs LogsQL over HTTP: GET /select/logsql/query?query=… returns one JSON object per
 *     line. Docs: https://docs.victoriametrics.com/victorialogs/querying/#http-api
 *   - Until VictoriaLogs exists in the chart the Service is missing and every OPA hop is red.
 */
import { baseUrl } from '../endpoints.mjs';
import { request } from '../http.mjs';
import { HopError } from '../hop.mjs';

export async function logsql(query, { limit = 1000, hop = 'logsql' } = {}) {
  const base = await baseUrl('victorialogs').catch((e) => {
    throw new HopError({ component: 'victorialogs', hop, reason: `no VictoriaLogs in the install (${e.reason ?? e.message})`, wp: 'WP-05' });
  });
  const qs = new URLSearchParams({ query, limit: String(limit) });
  const { text } = await request('victorialogs', hop, `${base}/select/logsql/query?${qs}`);
  return text.split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Parse the OPA event carried in a log line (_msg holds the JSON OPA printed). */
function opaEvent(line) {
  try { return typeof line._msg === 'string' ? JSON.parse(line._msg) : line; } catch { return line; }
}

/**
 * Decision log entries. `path` is the OPA query path (e.g. "os/authz/decision"), `action` the
 * input.action the OS sends (e.g. "files.create"); `match` further filters on the parsed event.
 */
export async function decisions({ path, action, sinceMinutes = 120, match } = {}) {
  const terms = [`_time:${Number(sinceMinutes)}m`, '"decision_id"'];
  if (path) terms.push(`"${path}"`);
  if (action) terms.push(`"${action}"`);
  const events = (await logsql(terms.join(' '), { hop: 'decision logs' })).map(opaEvent).filter((e) => e.decision_id);
  return events.filter((e) => (!action || e.input?.action === action) && (!match || match(e)));
}

export async function decisionById(decisionId) {
  const events = (await logsql(`"${decisionId}"`, { hop: 'decision log by id' })).map(opaEvent);
  return events.find((e) => e.decision_id === decisionId) ?? null;
}

/** Latest status report from one OPA instance (selected by a label OPA attaches, e.g. id). */
export async function latestStatus({ instanceLabel, sinceMinutes = 30 } = {}) {
  const events = (await logsql(`_time:${Number(sinceMinutes)}m "active_revision"${instanceLabel ? ` "${instanceLabel}"` : ''}`, { hop: 'status' })).map(opaEvent);
  const withBundles = events.filter((e) => e.bundles);
  if (!withBundles.length) throw new HopError({ component: 'opa', hop: 'status', reason: 'no OPA status report with bundles in VictoriaLogs', wp: 'WP-12' });
  return withBundles.at(-1);
}
