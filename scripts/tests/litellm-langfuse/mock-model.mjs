/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt) */
// A SCRIPTED OpenAI-compatible model for the Home chat live proof (scripts/tests/home-chat/live.sh).
// It is a mock, not a real model: it answers by simple rules so the browser run is repeatable.
//   - no `tools` (the PLAN call)            -> a one-line plan
//   - last message is a tool result         -> a short answer quoting that result
//   - user text has "who am i"              -> tool call whoami
//   - user text has "create"                -> tool call create_dataset (a write: the OS must ask)
//   - user text has "Save your previous answer" -> a call to the first tool it was offered
//   - otherwise                             -> a plain answer
// Honours `stream: true` (server-sent events, one word at a time, usage in the last chunk).
import { createServer } from 'node:http';

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const USAGE = { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 };

function decide(body) {
  const msgs = body.messages ?? [];
  const last = msgs[msgs.length - 1] ?? {};
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.content ?? '';
  if (!body.tools) return { text: '1. Answer the question with the governed tools.' };
  if (last.role === 'tool') return { text: `Here is what the governed tool returned: ${String(last.content).replace(/\s+/g, ' ').slice(0, 220)}` };
  if (/Save your previous answer/i.test(lastUser)) {
    const first = body.tools[0]?.function?.name;
    return { call: { name: first, args: { name: 'Sales overview', description: 'Saved from the Home chat' } } };
  }
  if (/who am i/i.test(lastUser)) return { call: { name: 'whoami', args: {} } };
  if (/create/i.test(lastUser)) return { call: { name: 'create_dataset', args: { name: 'orders_demo', description: 'Orders for the demo' } } };
  return { text: 'You can ask me about your data products, KPIs, files and knowledge, or ask me to build something. I will ask before I change anything.' };
}

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const url = req.url || '';
    if (url.startsWith('/api/public')) return json(res, 200, {});
    if (req.method === 'GET' && url.startsWith('/v1/models')) return json(res, 200, { object: 'list', data: [{ id: 'gpt-oss-20b', object: 'model' }] });
    if (req.method === 'POST' && url.startsWith('/v1/chat/completions')) {
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* empty */ }
      const d = decide(body);
      const base = { id: 'chatcmpl-mock', object: body.stream ? 'chat.completion.chunk' : 'chat.completion', created: Math.floor(Date.now() / 1000), model: body.model };
      const tc = d.call ? [{ id: 'call_mock1', type: 'function', function: { name: d.call.name, arguments: JSON.stringify(d.call.args) } }] : undefined;
      if (!body.stream) {
        return json(res, 200, { ...base, usage: USAGE, choices: [{ index: 0, finish_reason: tc ? 'tool_calls' : 'stop', message: { role: 'assistant', content: tc ? null : d.text, ...(tc ? { tool_calls: tc } : {}) } }] });
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (tc) {
        send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: tc[0].id, type: 'function', function: { name: tc[0].function.name, arguments: '' } }] } }] });
        send({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: tc[0].function.arguments } }] } }] });
      } else {
        for (const w of d.text.split(/(?<= )/)) { send({ ...base, choices: [{ index: 0, delta: { content: w } }] }); await new Promise((r) => setTimeout(r, 40)); }
      }
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: tc ? 'tool_calls' : 'stop' }] });
      send({ ...base, choices: [], usage: USAGE });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    json(res, 404, { error: 'not found', url });
  });
}).listen(Number(process.env.PORT || 8080), '0.0.0.0', () => console.log('mock model listening'));
