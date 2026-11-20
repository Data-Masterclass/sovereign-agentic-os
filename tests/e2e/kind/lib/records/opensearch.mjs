/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    Read OpenSearch's own records: the security audit log, the index, query profiles,
 *             ml-commons model stats, and the security plugin's view of a token
 * USER STORY: As AT-a I want "the search ran as u123, not as the OS's service user" to be proven
 *             by OpenSearch's security audit log, the only native evidence of who made the hop.
 * ARCHITECTURE:
 *   - Audit log: security plugin `plugins.security.audit.type: internal_opensearch` writes to
 *     `security-auditlog-YYYY.MM.dd`. Fields used: audit_category, audit_request_effective_user,
 *     audit_request_initiating_user, audit_rest_request_path, audit_trace_indices.
 *     Docs: https://docs.opensearch.org/latest/security/audit-logs/field-reference/
 *     The audit document has no backend-role field, so the role half of the assertion is read
 *     from `GET /_plugins/_security/authinfo` presented with the SAME token.
 *   - ml-commons: GET /_plugins/_ml/stats (per-model `predict.request_count`).
 *   - The harness reads as E2E_OPENSEARCH_AUTH (basic "user:pass"); once WP-22 turns the security
 *     plugin on, that is the audit reader's credential. With the plugin off, the audit index does
 *     not exist and the hop is red.
 */
import { baseUrl } from '../endpoints.mjs';
import { request, basic } from '../http.mjs';
import { HopError } from '../hop.mjs';

function authHeaders(extra = {}) {
  const a = process.env.E2E_OPENSEARCH_AUTH;
  return { 'content-type': 'application/json', ...(a ? { authorization: basic(...a.split(':')) } : {}), ...extra };
}

export async function os(path, { method = 'GET', body, headers, hop = path } = {}) {
  const { data } = await request('opensearch', hop, `${await baseUrl('opensearch')}${path}`, { method, body, headers: authHeaders(headers) });
  return data;
}

/** Audit entries for a user and an index, newest first. */
export async function auditEntries({ effectiveUser, index, categories = ['GRANTED_PRIVILEGES', 'AUTHENTICATED'], sinceMinutes = 120 }) {
  const must = [
    { range: { '@timestamp': { gte: `now-${Number(sinceMinutes)}m` } } },
    { terms: { audit_category: categories } },
  ];
  if (effectiveUser) must.push({ term: { audit_request_effective_user: effectiveUser } });
  if (index) must.push({ bool: { should: [{ term: { audit_trace_indices: index } }, { wildcard: { audit_rest_request_path: `*${index}*` } }] } });
  const exists = await os('/_cat/indices/security-auditlog-*?format=json', { hop: 'security-auditlog index' });
  if (!Array.isArray(exists) || !exists.length) {
    throw new HopError({ component: 'opensearch', hop: 'security audit log', reason: 'no security-auditlog-* index: the security plugin audit log is not enabled', wp: 'WP-22' });
  }
  const r = await os('/security-auditlog-*/_search', { method: 'POST', hop: 'security audit log', body: { size: 50, sort: [{ '@timestamp': 'desc' }], query: { bool: { must } } } });
  return r.hits.hits.map((h) => h._source);
}

/** What the security plugin resolves a bearer token to (user_name, backend_roles, roles). */
export async function authInfo(bearer) {
  const { data } = await request('opensearch', 'authinfo', `${await baseUrl('opensearch')}/_plugins/_security/authinfo`, { headers: { authorization: `Bearer ${bearer}` } });
  return data;
}

export async function search(index, body, { bearer, hop = `${index}/_search` } = {}) {
  const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
  return os(`/${index}/_search`, { method: 'POST', body, headers, hop });
}

export async function count(index, query) {
  return (await os(`/${index}/_count`, { method: 'POST', body: { query }, hop: `${index}/_count` })).count;
}

/** Sum of predict request counts for one ml-commons model across nodes. */
export async function mlPredictCount(modelId) {
  const stats = await os('/_plugins/_ml/stats', { hop: 'ml-commons stats' });
  let n = 0;
  let seen = false;
  for (const node of Object.values(stats.nodes ?? {})) {
    const m = node.models?.[modelId];
    if (m) { seen = true; n += m.predict?.ml_action_request_count ?? m.predict?.request_count ?? 0; }
  }
  if (!seen) throw new HopError({ component: 'opensearch', hop: 'ml-commons stats', reason: `model ${modelId} has no stats on any node` });
  return n;
}

export async function ingestPipeline(name) {
  return os(`/_ingest/pipeline/${name}`, { hop: `ingest pipeline ${name}` });
}
