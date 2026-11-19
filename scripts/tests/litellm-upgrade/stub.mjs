/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) */
// Tiny OpenAI-compatible upstream + Langfuse sink for the LiteLLM upgrade test. No dependencies.
// Upstream:  POST /v1/chat/completions  (fixed completion; a tool call when `tools` is sent;
//            429 when the last user message contains FORCE_429; 500 for FORCE_500)
//            POST /v1/embeddings, GET /v1/models
// Sink:      anything under /api/public/* (Langfuse legacy ingestion and OTLP) is recorded.
// Everything received is appended to $DATA_DIR/{upstream,langfuse}.jsonl for assertions.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';

const DATA = process.env.DATA_DIR || '/data';
mkdirSync(DATA, { recursive: true });
const rec = (file, obj) => appendFileSync(`${DATA}/${file}`, JSON.stringify(obj) + '\n');
const json = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
const USAGE = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const text = raw.toString('utf8');
    let body = null;
    try { body = JSON.parse(text); } catch { /* protobuf or empty */ }
    const url = req.url || '';

    if (url.startsWith('/api/public')) {
      rec('langfuse.jsonl', {
        at: new Date().toISOString(), method: req.method, url,
        contentType: req.headers['content-type'] || '',
        ingestionVersion: req.headers['x-langfuse-ingestion-version'] || '',
        sdk: req.headers['x-langfuse-sdk-name'] || req.headers['user-agent'] || '',
        hasAuth: Boolean(req.headers.authorization),
        bytes: raw.length,
        // JSON bodies are stored parsed; anything else as latin1 so content strings stay greppable.
        body: body ?? raw.toString('latin1'),
      });
      if (url.includes('/ingestion')) return json(res, 207, { successes: [], errors: [] });
      if (url.includes('/projects')) return json(res, 200, { data: [{ id: 'p', name: 'p' }] });
      return json(res, 200, {});
    }

    if (req.method === 'GET' && url.startsWith('/v1/models')) {
      return json(res, 200, { object: 'list', data: [{ id: 'gpt-oss-20b', object: 'model' }] });
    }
    if (req.method === 'POST' && url.startsWith('/v1/embeddings')) {
      rec('upstream.jsonl', { url, body });
      return json(res, 200, {
        object: 'list', model: body?.model,
        data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3] }],
        usage: { prompt_tokens: 8, total_tokens: 8 },
      });
    }
    if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
      rec('upstream.jsonl', { url, body });
      const last = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'user');
      const content = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '');
      if (content.includes('FORCE_429')) {
        return json(res, 429, { error: { message: 'upstream rate limit', type: 'rate_limit_error', code: 'rate_limit_exceeded' } }, { 'retry-after': '1' });
      }
      const failFor = /FAIL_MODEL=(\S+)/.exec(content)?.[1];
      if (failFor && String(body?.model ?? '').includes(failFor)) return json(res, 500, { error: { message: 'upstream exploded for this model', type: 'server_error' } });
      if (content.includes('FORCE_500')) return json(res, 500, { error: { message: 'upstream exploded', type: 'server_error' } });
      const base = { id: 'chatcmpl-stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body?.model, usage: USAGE };
      if (Array.isArray(body?.tools) && body.tools.length) {
        return json(res, 200, {
          ...base,
          choices: [{
            index: 0, finish_reason: 'tool_calls',
            message: {
              role: 'assistant', content: null,
              tool_calls: [{ id: 'call_stub_1', type: 'function', function: { name: body.tools[0].function.name, arguments: JSON.stringify({ note: 'TOOLARG_SECRET_MARKER' }) } }],
            },
          }],
        });
      }
      return json(res, 200, { ...base, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'COMPLETION_SECRET_MARKER fixed answer' } }] });
    }
    json(res, 404, { error: 'not found', url });
  });
}).listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('stub listening'));
