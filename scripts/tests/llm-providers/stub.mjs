/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) */
// Three stand-ins for MODEL PROVIDERS only — the one hop the provider test does not prove. Each
// speaks the wire protocol LiteLLM's own provider adapter sends, so a wrong adapter, a wrong
// prefix or a missing api_version fails here exactly as it would at the real provider:
//   STUB_KIND=openai  POST /v1/chat/completions        Authorization: Bearer <KEY>
//                     POST /v1/embeddings
//   STUB_KIND=azure   POST /openai/deployments/<DEPLOYMENT>/chat/completions?api-version=<VER>
//                     header api-key: <KEY>  (Azure OpenAI's own auth header)
//   STUB_KIND=ollama  POST /api/chat                   (no auth; Ollama has none)
// Every request is logged as one JSON line on stdout and, with DATA_DIR set, appended to
// $DATA_DIR/<STUB_NAME>.jsonl, so the test can read which hop happened (and that a blocked one did not).
// A wrong key answers 401 with the provider's usual error shape. No dependencies.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const KIND = process.env.STUB_KIND || 'openai';
const KEY = process.env.STUB_KEY || 'sk-stub-right';
const DEPLOYMENT = process.env.STUB_DEPLOYMENT || 'os-gpt-deploy';
const VERSION = process.env.STUB_API_VERSION || '2024-10-21';
const NAME = process.env.STUB_NAME || KIND;
const DATA = process.env.DATA_DIR || '';
const USAGE = { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 };

const send = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const completion = (model) => ({
  id: `chatcmpl-${KIND}`, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model, usage: USAGE,
  choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: `STUB-${KIND} answered as ${model}` } }],
});

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { /* not JSON */ }
    const url = new URL(req.url || '/', 'http://stub');
    const log = (extra) => {
      const line = JSON.stringify({ stub: NAME, kind: KIND, host: req.headers.host, method: req.method, path: url.pathname, query: url.search, model: body.model, ...extra });
      console.log(line);
      if (DATA) appendFileSync(`${DATA}/${NAME}.jsonl`, line + '\n');
    };
    if (KIND === 'openai') {
      const ok = req.headers.authorization === `Bearer ${KEY}`;
      log({ auth_ok: ok });
      if (!ok) return send(res, 401, { error: { message: 'Incorrect API key provided.', type: 'invalid_request_error', code: 'invalid_api_key' } });
      if (req.method === 'POST' && url.pathname === '/v1/chat/completions') return send(res, 200, completion(body.model));
      if (req.method === 'POST' && url.pathname === '/v1/embeddings') {
        return send(res, 200, { object: 'list', model: body.model, usage: { prompt_tokens: 3, total_tokens: 3 }, data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }] });
      }
    }
    if (KIND === 'azure') {
      const ok = req.headers['api-key'] === KEY;
      const want = `/openai/deployments/${DEPLOYMENT}/chat/completions`;
      const version = url.searchParams.get('api-version');
      log({ auth_ok: ok, api_version: version });
      if (url.pathname !== want) return send(res, 404, { error: { code: 'DeploymentNotFound', message: `The API deployment for this resource does not exist (asked ${url.pathname}).` } });
      if (version !== VERSION) return send(res, 404, { error: { code: '404', message: `Resource not found (api-version ${version})` } });
      if (!ok) return send(res, 401, { error: { code: '401', message: 'Access denied due to invalid subscription key or wrong API endpoint.' } });
      return send(res, 200, completion(DEPLOYMENT));
    }
    if (KIND === 'ollama') {
      log({});
      if (req.method === 'POST' && url.pathname === '/api/chat') {
        return send(res, 200, {
          model: body.model, created_at: new Date().toISOString(), done: true, done_reason: 'stop',
          message: { role: 'assistant', content: `STUB-ollama answered as ${body.model}` },
          prompt_eval_count: USAGE.prompt_tokens, eval_count: USAGE.completion_tokens,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/tags') return send(res, 200, { models: [{ name: 'llama3.2:1b', model: 'llama3.2:1b' }] });
    }
    log({ unmatched: true });
    send(res, 404, { error: { message: `stub ${KIND}: no route ${req.method} ${url.pathname}` } });
  });
}).listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log(JSON.stringify({ stub: KIND, listening: true })));
