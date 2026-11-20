/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       acceptance harness (tests/e2e/kind)
 * FEATURE:    AT-a journey-a-knowledge.e2e — PDF → Docling → OpenSearch → agent search as the user
 *             → knowledge note → one trace
 * USER STORY: As the owner I want proof, from each component's own record, that a contract PDF
 *             uploaded by u123 is parsed by Docling, embedded inside OpenSearch, found by an agent
 *             searching AS u123 (and not by u999), turned into a knowledge note authored by u123,
 *             and traced once in Langfuse with exactly one generation per model call.
 * ARCHITECTURE:
 *   - Authoritative: 09 §5 AT-a; MASTER-PLAN Part 2 §C row AT-a; 10 F1/F3/F12.
 *   - Every assertion reads a component record (Docling log, SeaweedFS object, OpenSearch index /
 *     audit log / ml-commons stats, LiteLLM spend log, git, Langfuse observations, OPA decision
 *     log). The OS is only DRIVEN (lib/os-driver.mjs); its answers are never the proof.
 *   - Retrieval is real: the stub's embedding rules give the query and the answer row one shared
 *     topic (they share no word), and a 36-page distractor PDF that USES the query's words is
 *     uploaded first. The answer must be rank 1, which only k-NN can achieve; a keyword match ranks a
 *     distractor first (a-twin-5).
 *   - All assertions and twins are expected-fail until the WPs named in each marker land.
 */
import { journey, check } from '../lib/journey.mjs';
import { PRINCIPALS, DOMAIN, OTHER_DOMAIN, createTraceId, jwtPayload, waitFor, isoNow } from '../lib/common.mjs';
import { contractPdf, distractorPdf, QUERY, ANSWER_CELL, EMBEDDING_RULES, DISTRACTOR_PAGES } from '../fixtures/contract-pdf.mjs';
import { toolOutputs, assertTopHitIsAnswer, assertChunkNotVisible } from '../lib/checks/knowledge.mjs';
import { callTool, uploadFile } from '../lib/os-driver.mjs';
import * as stub from '../lib/records/stub.mjs';
import * as docling from '../lib/records/docling.mjs';
import * as s3 from '../lib/records/s3.mjs';
import * as osr from '../lib/records/opensearch.mjs';
import * as litellm from '../lib/records/litellm.mjs';
import * as langfuse from '../lib/records/langfuse.mjs';
import * as opa from '../lib/records/opa.mjs';
import * as git from '../lib/records/git.mjs';
import { kubectl, NS } from '../lib/kube.mjs';

const { U, OTHER } = PRINCIPALS;
const FILES_INDEX = 'files';
const KNOWLEDGE_INDEX = 'knowledge';
const INGEST_PIPELINE = process.env.E2E_FILES_PIPELINE ?? 'files-ingest';
const INGEST_KEY_ALIAS = 'opensearch-ingest';
const DLS_ROLE = process.env.E2E_DLS_ROLE ?? 'os_files_reader';
const NOTE_PHRASE = 'Northpeak contracts carry a ninety-day notice window';
const J = journey('AT-a', 'journey-a-knowledge');

// ---------------------------------------------------------------- the model script (the only fake)
const SCRIPT = (uid) => [
  { match: QUERY, reply: { tool_calls: [{ name: 'search_files', arguments: { query: QUERY } }] } },
  { reply: { tool_calls: [{ name: 'author_knowledge', arguments: { title: `Contract notice periods (${uid})`, domain: uid === OTHER ? OTHER_DOMAIN : DOMAIN, markdown: NOTE_PHRASE } }] } },
  { reply: { content: `The notice period is ${ANSWER_CELL} (Annex B, page 2).` } },
];

// ---------------------------------------------------------------- steps (cause the hops)
async function uploadAndIndex(name) {
  const startedAt = isoNow();
  const ml0 = await mlPredict();
  const file = await uploadFile(U, { name, bytes: contractPdf() });
  await waitFor(async () => (await osr.count(FILES_INDEX, { term: { file_id: file.id } })) > 0,
    { component: 'opensearch', hop: `${FILES_INDEX} index`, what: `documents for file ${file.id}` });
  return { file, startedAt, ml0 };
}

async function modelIdOfPipeline() {
  const p = await osr.ingestPipeline(INGEST_PIPELINE);
  const procs = p[INGEST_PIPELINE]?.processors ?? [];
  const emb = procs.map((x) => x.text_embedding ?? x.text_chunking ?? null).find((x) => x?.model_id);
  check(emb, 'opensearch', `ingest pipeline ${INGEST_PIPELINE} has a text_embedding processor with a model_id`, procs);
  return emb.model_id;
}
async function mlPredict() { return osr.mlPredictCount(await modelIdOfPipeline()); }

const upload = () => J.step('upload', async () => {
  await stub.loadEmbeddingRules(EMBEDDING_RULES);
  const distractors = await uploadFile(U, { name: 'kickoff-memos-at-a.pdf', bytes: distractorPdf() });
  await waitFor(async () => (await osr.count(FILES_INDEX, { term: { file_id: distractors.id } })) >= DISTRACTOR_PAGES,
    { component: 'opensearch', hop: `${FILES_INDEX} index`, what: `${DISTRACTOR_PAGES} distractor chunks` });
  return uploadAndIndex('contract-at-a.pdf');
});
// Each principal runs the same assistant in its OWN domain: u999 (marketing) must not reach sales files.
const systemFor = (uid) => J.step(`system for ${uid}`, () => callTool(uid, 'create_agent_system', { name: `AT-a contracts assistant (${uid})`, domain: uid === OTHER ? OTHER_DOMAIN : DOMAIN, template: 'analyze' }));

async function runAs(uid) {
  await stub.reset();
  await stub.loadEmbeddingRules(EMBEDDING_RULES);
  await stub.loadScript(SCRIPT(uid));
  const { id: systemId } = await systemFor(uid);
  const startedAt = isoNow();
  const run = await callTool(uid, 'run_agent_system', { systemId, message: QUERY });
  check(run?.runId, 'os-ui', 'run_agent_system returns a runId', run);
  const traceId = createTraceId(run.runId);
  const obs = await waitFor(async () => {
    const o = await langfuse.observations({ traceId });
    return o.some((x) => x.type === 'TOOL' && x.name === 'search_files') ? o : null;
  }, { component: 'langfuse', hop: 'observations v2', what: `TOOL search_files in trace ${traceId}` });
  return { run, traceId, startedAt, obs, stubChats: await stub.chatCount() };
}
const runU = () => J.step('run as u123', async () => { await upload(); return runAs(U); });
const run999 = () => J.step('run as u999', async () => { await runU(); return runAs(OTHER); });


// ---------------------------------------------------------------- 1. Docling
J.assertion('a1.1', { hop: 'Docling converts and chunks (two async tasks)', record: 'docling-serve access log', expectedFail: 'WP-41' }, async () => {
  const { startedAt } = await upload();
  const calls = await docling.asyncCallsSeen('1h');
  check(calls.convert >= 1 && calls.chunk >= 1, 'docling', 'access log has POST /v1/convert/file/async and POST /v1/chunk/hybrid/file/async', calls);
  const ids = await docling.taskIdsSeen('1h');
  check(ids.size >= 2, 'docling', `at least two task ids polled since ${startedAt}`, [...ids]);
});

J.assertion('a1.2', { hop: '.docling.json stored beside the blob', record: 'SeaweedFS object (files bucket)', expectedFail: 'WP-41' }, async () => {
  const { file } = await upload();
  check(file.objectKey, 'os-ui', 'upload returns the object key of the blob', file);
  const meta = await s3.head('files', `${file.objectKey}.docling.json`);
  check(meta && meta.size > 0, 'seaweedfs', `files/${file.objectKey}.docling.json exists and is non-empty`, meta);
  const doc = await s3.getJson('files', `${file.objectKey}.docling.json`);
  check(doc.schema_name === 'DoclingDocument', 'seaweedfs', '.docling.json is a DoclingDocument', doc.schema_name);
});

// ---------------------------------------------------------------- 2. OpenSearch indexing
J.assertion('a2.1', { hop: 'one OpenSearch document per Docling chunk', record: 'OpenSearch files index + DoclingDocument', expectedFail: 'WP-41' }, async () => {
  const { file } = await upload();
  const doc = await s3.getJson('files', `${file.objectKey}.docling.json`);
  const indexed = await osr.count(FILES_INDEX, { term: { file_id: file.id } });
  const chunkIds = await osr.search(FILES_INDEX, { size: 0, query: { term: { file_id: file.id } }, aggs: { c: { cardinality: { field: 'chunk_id' } } } });
  check(indexed > 0 && indexed === chunkIds.aggregations.c.value, 'opensearch', 'doc count equals distinct chunk ids', { indexed, distinct: chunkIds.aggregations.c.value });
  check(doc.tables?.length >= 1, 'docling', 'DoclingDocument has the page-2 table', doc.tables?.length ?? 0);
});

const nullVectors = async (fileId) => osr.count(FILES_INDEX, { bool: { filter: [{ term: { file_id: fileId } }], must_not: [{ exists: { field: 'vector' } }] } });
J.assertion('a2.2', { hop: 'every chunk has a vector (index-time embedding)', record: 'OpenSearch files index', expectedFail: 'WP-24' }, async () => {
  const { file } = await upload();
  const n = await nullVectors(file.id);
  check(n === 0, 'opensearch', 'no document of the file lacks `vector`', `${n} documents without vector`);
});

J.assertion('a2.3', { hop: 'ml-commons predict count increased', record: 'OpenSearch /_plugins/_ml/stats', expectedFail: 'WP-24' }, async () => {
  const { ml0 } = await upload();
  const ml1 = await mlPredict();
  check(ml1 > ml0, 'opensearch', 'predict request count grew during ingest', { before: ml0, after: ml1 });
});

J.assertion('a2.4', { hop: 'embedding went through LiteLLM with key opensearch-ingest', record: 'LiteLLM spend logs', expectedFail: 'WP-24' }, async () => {
  const { startedAt } = await upload();
  const rows = litellm.byKeyAlias(await litellm.spendLogs({ startDate: startedAt.slice(0, 10) }), INGEST_KEY_ALIAS)
    .filter((r) => r.startTime >= startedAt);
  check(rows.length > 0, 'litellm', `spend rows for key alias ${INGEST_KEY_ALIAS} since ${startedAt}`, rows.length);
});

// ---------------------------------------------------------------- 3. search as the user
J.assertion('a3.1', { hop: 'the agent run as u123 gets the page-2 table chunk at rank 1 (out of 36+ chunks)', record: 'Langfuse TOOL observation search_files (io)', expectedFail: 'WP-27' }, async () => {
  const { obs } = await runU();
  assertTopHitIsAnswer(obs, { answer: ANSWER_CELL, page: 2 });
});

J.assertion('a3.2', { hop: 'OpenSearch audit log: request made AS u123 with an aud=opensearch JWT carrying domain:sales', record: 'security-auditlog-*', expectedFail: 'WP-25' }, async () => {
  const { startedAt } = await runU();
  const entries = (await osr.auditEntries({ effectiveUser: U, index: FILES_INDEX })).filter((e) => e['@timestamp'] >= startedAt);
  check(entries.length > 0, 'opensearch', `audit entries with audit_request_effective_user=${U} on ${FILES_INDEX}`, 0);
  // The audit document has no role field; the harness profile keeps headers (exclude_sensitive_headers:false),
  // so the bearer OpenSearch authenticated is in the record itself.
  const auth = entries.map((e) => e.audit_rest_request_headers?.Authorization?.[0]).find(Boolean);
  const claims = jwtPayload(auth ?? '');
  check(claims, 'opensearch', 'audit entry carries the JWT bearer it authenticated', auth ? 'non-JWT header' : 'no Authorization header');
  check(claims.sub === U && [].concat(claims.aud).includes('opensearch'), 'opensearch', `JWT sub=${U}, aud=opensearch`, claims);
  check([].concat(claims.roles ?? []).includes(`domain:${DOMAIN}`), 'opensearch', `JWT roles include domain:${DOMAIN}`, claims.roles);
  const info = await osr.authInfo(auth.replace(/^Bearer\s+/i, ''));
  check(info.user_name === U && info.backend_roles.includes(`domain:${DOMAIN}`), 'opensearch', 'security plugin resolves that token to u123 with backend role domain:sales', info);
});

J.assertion('a3.3', { hop: 'profile:true replay shows the k-NN sub-query scored the hit', record: 'OpenSearch search profile', expectedFail: 'WP-24' }, async () => {
  const { startedAt } = await runU();
  const entry = (await osr.auditEntries({ effectiveUser: U, index: FILES_INDEX })).find((e) => e['@timestamp'] >= startedAt && e.audit_request_body);
  check(entry, 'opensearch', 'audit entry with the search request body', null);
  const body = JSON.parse(entry.audit_request_body);
  const res = await osr.search(FILES_INDEX, { ...body, profile: true });
  check(res.hits.total.value > res.hits.hits.length || res.hits.hits.length < DISTRACTOR_PAGES, 'opensearch', 'top-k is smaller than the corpus', res.hits.total);
  check(JSON.stringify(res.hits.hits[0]?._source ?? {}).includes(ANSWER_CELL), 'opensearch', 'replayed query ranks the page-2 chunk first', res.hits.hits[0]?._source);
  const types = JSON.stringify(res.profile.shards.map((s) => s.searches.map((x) => x.query.map((q) => q.type))));
  check(/knn/i.test(types), 'opensearch', 'profile contains a KNN query node', types.slice(0, 300));
});

J.assertion('a3.4', { hop: 'the same query as u999 returns 0 hits (DLS)', record: 'Langfuse TOOL observation + OpenSearch audit log', expectedFail: 'WP-25' }, async () => {
  const { obs, startedAt } = await run999();
  assertChunkNotVisible(obs, { answer: ANSWER_CELL });
  const entries = (await osr.auditEntries({ effectiveUser: OTHER, index: FILES_INDEX })).filter((e) => e['@timestamp'] >= startedAt);
  check(entries.length > 0, 'opensearch', 'the u999 search reached OpenSearch as u999', 0);
});

// ---------------------------------------------------------------- 4. knowledge note
J.assertion('a4.1', { hop: 'knowledge note committed with author u123', record: 'git log (domain repo)', expectedFail: 'WP-50' }, async () => {
  const { obs } = await runU();
  const out = toolOutputs(obs, 'author_knowledge').join('\n');
  const path = /knowledge\/[\w/.-]+\.md/.exec(out)?.[0];
  check(path, 'langfuse', 'author_knowledge output names the committed knowledge/** path', out.slice(0, 300));
  const dir = await git.clone(DOMAIN);
  const log = await git.logFor(dir, path);
  check(log.length && log[0].author === U, 'git', `last commit of ${path} authored by ${U}`, log[0]);
});

J.assertion('a4.2', { hop: 'a second search finds the note', record: 'OpenSearch knowledge index', expectedFail: 'WP-50' }, async () => {
  await runU();
  const hit = await waitFor(async () => (await osr.search(KNOWLEDGE_INDEX, { query: { match_phrase: { content: NOTE_PHRASE } } })).hits.total.value > 0,
    { component: 'opensearch', hop: `${KNOWLEDGE_INDEX} index`, what: 'the note passage', timeoutMs: 120000 });
  check(hit, 'opensearch', 'note passage is searchable', hit);
});

// ---------------------------------------------------------------- 5. one trace
J.assertion('a5.1', { hop: 'one trace as u123 with TOOL search_files + author_knowledge', record: 'Langfuse Observations v2', expectedFail: 'WP-33' }, async () => {
  const { obs, traceId } = await runU();
  check(obs.every((o) => o.userId === U), 'langfuse', `every observation of ${traceId} has userId=${U}`, [...new Set(obs.map((o) => o.userId))]);
  const tools = new Set(langfuse.byType(obs, 'TOOL').map((o) => o.name));
  check(tools.has('search_files') && tools.has('author_knowledge'), 'langfuse', 'TOOL observations search_files and author_knowledge', [...tools]);
  check(langfuse.roots(obs).length === 1, 'langfuse', 'exactly one root observation', langfuse.roots(obs).length);
});

J.assertion('a5.2', { hop: 'exactly N GENERATIONs with litellm_call_id, N = stub request count', record: 'Langfuse Observations v2 + model stub counter', expectedFail: 'WP-32' }, async () => {
  const { obs, stubChats } = await runU();
  const gens = langfuse.byType(obs, 'GENERATION');
  check(stubChats > 0 && gens.length === stubChats, 'langfuse', `GENERATION count equals the stub's ${stubChats} chat calls`, gens.length);
  const withId = gens.filter((g) => g.metadata?.litellm_call_id ?? g.metadata?.attributes?.['litellm.call_id']);
  check(withId.length === gens.length, 'langfuse', 'every GENERATION carries litellm_call_id', `${withId.length}/${gens.length}`);
});

// ---------------------------------------------------------------- 6. policy
J.assertion('a6.1', { hop: 'OPA decided files.create and run.act_as for this run', record: 'OPA decision logs (VictoriaLogs)', expectedFail: 'WP-06' }, async () => {
  const { run } = await runU();
  const creates = await opa.decisions({ action: 'files.create', match: (e) => e.input?.subject?.id === U });
  check(creates.length > 0, 'opa', `files.create decision for ${U}`, 0);
  const actAs = await opa.decisions({ action: 'run.act_as', match: (e) => JSON.stringify(e.input ?? {}).includes(run.runId) });
  check(actAs.length > 0 && actAs.every((e) => e.result?.allow !== false), 'opa', `run.act_as decisions for run ${run.runId}, all allowed`, actAs.length);
});

// ---------------------------------------------------------------- negative twins
async function freshFileHasVectors() {
  const { file } = await uploadAndIndex(`contract-twin-${Date.now()}.pdf`);
  const n = await nullVectors(file.id);
  check(n === 0, 'opensearch', 'fresh upload: no document without vector', `${n} without vector`);
}
let savedPipeline;
J.twin('a-twin-1', { disables: `ingest pipeline ${INGEST_PIPELINE} removed`, record: 'OpenSearch files index', expectedFail: 'WP-24', redReasonMust: /fresh upload: no document without vector|documents for file \S+ not seen/ }, {
  check: freshFileHasVectors,
  disable: async () => {
    savedPipeline = (await osr.ingestPipeline(INGEST_PIPELINE))[INGEST_PIPELINE];
    await osr.os(`/_ingest/pipeline/${INGEST_PIPELINE}`, { method: 'DELETE' });
  },
  restore: async () => { if (savedPipeline) await osr.os(`/_ingest/pipeline/${INGEST_PIPELINE}`, { method: 'PUT', body: savedPipeline }); },
});

let savedRole;
J.twin('a-twin-2', { disables: `DLS clause removed from role ${DLS_ROLE}`, record: 'Langfuse TOOL output for u999', expectedFail: 'WP-25', redReasonMust: /search_files output does not contain "90 days"/ }, {
  check: async () => {
    const { obs } = await runAs(OTHER);
    assertChunkNotVisible(obs, { answer: ANSWER_CELL });
  },
  disable: async () => {
    savedRole = (await osr.os(`/_plugins/_security/api/roles/${DLS_ROLE}`))[DLS_ROLE];
    const open = { ...savedRole, index_permissions: savedRole.index_permissions.map(({ dls, ...p }) => p) };
    for (const k of ['reserved', 'hidden', 'static']) delete open[k];
    await osr.os(`/_plugins/_security/api/roles/${DLS_ROLE}`, { method: 'PUT', body: open });
  },
  restore: async () => {
    if (!savedRole) return;
    const back = { ...savedRole };
    for (const k of ['reserved', 'hidden', 'static']) delete back[k];
    await osr.os(`/_plugins/_security/api/roles/${DLS_ROLE}`, { method: 'PUT', body: back });
  },
});

// LiteLLM back on its legacy `langfuse` callback against Langfuse v4 (10 F1): generations must go missing.
const LITELLM_CM = process.env.E2E_LITELLM_CONFIGMAP ?? 'agentic-os-litellm';
let savedLitellm;
async function patchLitellm(transform) {
  const cm = JSON.parse(await kubectl(['-n', NS, 'get', 'configmap', LITELLM_CM, '-o', 'json']));
  const key = Object.keys(cm.data).find((k) => /config/.test(k));
  savedLitellm ??= cm.data[key];
  cm.data[key] = transform(cm.data[key]);
  await kubectl(['-n', NS, 'apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: LITELLM_CM, namespace: NS }, data: cm.data }) });
  await kubectl(['-n', NS, 'rollout', 'restart', 'deployment/agentic-os-litellm']);
  await kubectl(['-n', NS, 'rollout', 'status', 'deployment/agentic-os-litellm', '--timeout=300s'], { timeoutMs: 320000 });
}
J.twin('a-twin-3', { disables: 'LiteLLM on the legacy langfuse callback (not langfuse_otel) against Langfuse v4', record: 'Langfuse Observations v2', expectedFail: 'WP-32', redReasonMust: /GENERATION count equals stub count/ }, {
  check: async () => {
    const { obs, stubChats } = await runAs(U);
    check(langfuse.byType(obs, 'GENERATION').length === stubChats, 'langfuse', 'GENERATION count equals stub count', langfuse.byType(obs, 'GENERATION').length);
  },
  disable: () => patchLitellm((cfg) => cfg.replace(/langfuse_otel/g, 'langfuse')),
  restore: async () => { if (savedLitellm) await patchLitellm(() => savedLitellm); },
});

// The worker claims the run before the run grant reaches OPA (10 F3): search as u123 must STILL pass.
const OPA_CM = process.env.E2E_OPA_CONFIGMAP ?? 'opa-config';
let savedOpa;
J.twin('a-twin-4', { disables: 'bundle propagation slowed (min_delay 30 s) so the worker claims before the grant arrives', record: 'Langfuse TOOL output for u123', expect: 'green', expectedFail: 'WP-11' }, {
  check: async () => {
    const { obs } = await runAs(U);
    assertTopHitIsAnswer(obs, { answer: ANSWER_CELL, page: 2 });
  },
  disable: async () => {
    const cm = JSON.parse(await kubectl(['-n', NS, 'get', 'configmap', OPA_CM, '-o', 'json']));
    savedOpa = cm.data;
    const data = Object.fromEntries(Object.entries(cm.data).map(([k, v]) => [k, v.replace(/min_delay_seconds:\s*\d+/g, 'min_delay_seconds: 30').replace(/max_delay_seconds:\s*\d+/g, 'max_delay_seconds: 45')]));
    await kubectl(['-n', NS, 'apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: OPA_CM, namespace: NS }, data }) });
    await kubectl(['-n', NS, 'rollout', 'restart', 'deployment/opa']);
    await kubectl(['-n', NS, 'rollout', 'status', 'deployment/opa', '--timeout=180s'], { timeoutMs: 200000 });
  },
  restore: async () => {
    if (!savedOpa) return;
    await kubectl(['-n', NS, 'apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: OPA_CM, namespace: NS }, data: savedOpa }) });
    await kubectl(['-n', NS, 'rollout', 'restart', 'deployment/opa']);
  },
});

// Retrieval replaced by a keyword match: the hybrid search pipeline's weights set to lexical-only
// (OpenSearch's own score-ranker/normalization processor config). The query shares no word with the
// answer and every word with the distractors, so rank 1 MUST stop being the answer.
const SEARCH_PIPELINE = process.env.E2E_SEARCH_PIPELINE ?? 'files-hybrid';
let savedSearchPipeline;
J.twin('a-twin-5', { disables: `search pipeline ${SEARCH_PIPELINE} weighted lexical-only (k-NN weight 0)`, record: 'Langfuse TOOL output for u123', expectedFail: 'WP-24', redReasonMust: /rank 1 hit contains "90 days"/ }, {
  check: async () => {
    const { obs } = await runAs(U);
    assertTopHitIsAnswer(obs, { answer: ANSWER_CELL, page: 2 });
  },
  disable: async () => {
    const got = await osr.os(`/_search/pipeline/${SEARCH_PIPELINE}`);
    savedSearchPipeline = got[SEARCH_PIPELINE];
    check(savedSearchPipeline, 'opensearch', `search pipeline ${SEARCH_PIPELINE} exists`, Object.keys(got));
    const lexicalOnly = JSON.parse(JSON.stringify(savedSearchPipeline));
    for (const proc of lexicalOnly.phase_results_processors ?? []) {
      const p = proc['normalization-processor'] ?? proc['score-ranker-processor'];
      if (p) p.combination = { ...(p.combination ?? {}), parameters: { ...(p.combination?.parameters ?? {}), weights: [1.0, 0.0] } };
    }
    await osr.os(`/_search/pipeline/${SEARCH_PIPELINE}`, { method: 'PUT', body: lexicalOnly });
  },
  restore: async () => { if (savedSearchPipeline) await osr.os(`/_search/pipeline/${SEARCH_PIPELINE}`, { method: 'PUT', body: savedSearchPipeline }); },
});
