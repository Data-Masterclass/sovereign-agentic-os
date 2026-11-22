/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) */
// OpenAI-compatible stand-in for the MODEL PROVIDER only (the one hop this test does not prove),
// plus a header sink. No dependencies.
//   POST /v1/chat/completions -> a fixed completion with fixed usage (1000 in / 500 out), so the
//                                test can tell one generation from two by the token total.
//   anything under /api/public -> recorded (method, url, headers) in $DATA_DIR/sink.jsonl and
//                                answered 200; used once to read the headers LiteLLM's OTLP
//                                exporter sends (x-langfuse-ingestion-version).
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync } from 'node:fs';

const DATA = process.env.DATA_DIR || '/data';
mkdirSync(DATA, { recursive: true });
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
export const USAGE = { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 };

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = req.url || '';
    if (url.startsWith('/api/public')) {
      appendFileSync(`${DATA}/sink.jsonl`, JSON.stringify({ method: req.method, url, headers: req.headers, bytes: Buffer.concat(chunks).length }) + '\n');
      return json(res, 200, {});
    }
    if (req.method === 'GET' && url.startsWith('/v1/models')) return json(res, 200, { object: 'list', data: [{ id: 'gpt-oss-20b', object: 'model' }] });
    if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* empty */ }
      // A worker delegation (core/runtime/delegate.ts) asks for ONE JSON object {"result", "confidence"}: answer it.
      const asksDelegation = (body.messages ?? []).some((m) => typeof m.content === 'string' && m.content.includes('"confidence"') && m.content.includes('Answer ONE JSON object {"result"'));
      const content = asksDelegation ? JSON.stringify({ result: { summary: 's', key_figures: [] }, confidence: 0.9 }) : 'COMPLETION_CANARY_7f3a fixed answer';
      return json(res, 200, {
        id: 'chatcmpl-stub', object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model, usage: USAGE,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      });
    }
    json(res, 404, { error: 'not found', url });
  });
}).listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('stub listening'));
