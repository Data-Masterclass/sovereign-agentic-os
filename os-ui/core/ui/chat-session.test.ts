/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Ask the OS chat session — behaviour tests
 * USER STORY: As a user I want a chat started on Home to keep running when I change tabs.
 * ARCHITECTURE:
 *   - Drives the real store (`createChatSession`) with a fetch double that returns a real `Response`
 *     over a `ReadableStream` the test feeds line by line, the way `/api/assistant/chat` streams NDJSON.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatSession, type ChatSnapshot } from '@core/ui/chat-session';
import { launcherView } from '@core/ui/chat-launcher';

type Call = { url: string; body: Record<string, unknown>; signal?: AbortSignal | null };

/** A fetch double whose chat stream the test controls: `push(event)`, then `end()`. */
function streamingFetch() {
  const calls: Call[] = [];
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')), signal: init?.signal });
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    init?.signal?.addEventListener('abort', () => {
      try { controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })); } catch { /* already closed */ }
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson; charset=utf-8' } });
  }) as typeof fetch;
  return {
    calls,
    fetchImpl,
    push: (ev: unknown) => controller.enqueue(enc.encode(`${JSON.stringify(ev)}\n`)),
    end: () => controller.close(),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function until(pred: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) { if (pred()) return; await tick(); }
  assert.fail(`timed out waiting for: ${what}`);
}

let n = 0;
const ids = () => `conv${String(++n).padStart(6, '0')}`;

test('the stream keeps running after the subscribing view unsubscribes, and the answer lands in the store', async () => {
  const f = streamingFetch();
  const s = createChatSession({ fetch: f.fetchImpl, newId: ids });
  const seen: ChatSnapshot[] = [];
  const unsubscribe = s.subscribe(() => seen.push(s.getSnapshot()));
  const turn = s.send('how many orders last week?');
  await until(() => f.calls.length === 1, 'the request');
  f.push({ type: 'step', name: 'query_data', isError: false });
  await until(() => s.getSnapshot().live.length === 1, 'the first live step');
  unsubscribe(); // the Home chat unmounts: the user opened another tab
  f.push({ type: 'token', t: 'There were ' });
  f.push({ type: 'token', t: '42.' });
  await until(() => s.getSnapshot().draft === 'There were 42.', 'the streamed draft');
  assert.equal(s.getSnapshot().busy, true);
  f.push({ type: 'done', content: 'There were 42 orders.', tools: [{ name: 'query_data', isError: false }], saveAs: ['kpi'] });
  f.end();
  await turn;
  const after = s.getSnapshot();
  assert.equal(after.busy, false);
  assert.equal(after.messages.length, 2);
  assert.equal(after.messages[1].content, 'There were 42 orders.');
  assert.deepEqual(after.messages[1].steps, [{ name: 'query_data', isError: false }]);
  assert.deepEqual(after.messages[1].saveAs, ['kpi']);
  assert.equal(after.live.length, 0);
  assert.equal(f.calls[0].signal?.aborted, false, 'unsubscribing never aborts the turn');
  assert.ok(seen.length > 0 && seen.every((x) => x.busy), 'the unsubscribed listener heard nothing after it left');
});

test('a second subscriber sees the same live state as the first', async () => {
  const f = streamingFetch();
  const s = createChatSession({ fetch: f.fetchImpl, newId: ids });
  let homeView: ChatSnapshot | null = null;
  let panelView: ChatSnapshot | null = null;
  s.subscribe(() => { homeView = s.getSnapshot(); });
  const turn = s.send('build me a dashboard');
  await until(() => f.calls.length === 1, 'the request');
  s.subscribe(() => { panelView = s.getSnapshot(); }); // the panel opens mid-turn
  f.push({ type: 'status', message: 'The model is busy — retrying…' });
  f.push({ type: 'step', name: 'create_dashboard', isError: false, parked: true });
  await until(() => s.getSnapshot().live.length === 1, 'the step');
  assert.strictEqual(homeView, panelView, 'both views read the same snapshot object');
  assert.equal(panelView!.live[0].name, 'create_dashboard');
  assert.equal(panelView!.messages[0].content, 'build me a dashboard');
  f.push({ type: 'done', content: 'Done.', pending: [{ confirmationId: 'cf1', tool: 'create_dashboard', args: {}, expiresAt: '' }] });
  f.end();
  await turn;
  assert.equal(s.getSnapshot().messages[1].pending?.[0].state, 'open');
  s.patchPending(1, 0, { state: 'running' });
  assert.equal(s.getSnapshot().messages[1].pending?.[0].state, 'running');
});

test('stop aborts the request and ends the turn without an error', async () => {
  const f = streamingFetch();
  const s = createChatSession({ fetch: f.fetchImpl, newId: ids });
  const turn = s.send('long question');
  await until(() => f.calls.length === 1, 'the request');
  f.push({ type: 'step', name: 'list_datasets', isError: false });
  await until(() => s.getSnapshot().live.length === 1, 'the step');
  s.stop();
  await turn;
  assert.equal(f.calls[0].signal?.aborted, true);
  const after = s.getSnapshot();
  assert.equal(after.busy, false);
  assert.equal(after.error, '');
  assert.equal(after.ready, false, 'a stopped turn is not an answer');
  assert.equal(after.messages.length, 1);
});

test('busy → done sets the ready flag when no view is attached; attaching a view clears it', async () => {
  const f = streamingFetch();
  const s = createChatSession({ fetch: f.fetchImpl, newId: ids });
  const turn = s.send('summarise my KPIs');
  await until(() => f.calls.length === 1, 'the request');
  assert.equal(launcherView(s.getSnapshot(), '/data', false).state, 'working');
  f.push({ type: 'done', content: 'Here they are.' });
  f.end();
  await turn;
  assert.equal(s.getSnapshot().ready, true);
  assert.equal(launcherView(s.getSnapshot(), '/data', false).state, 'ready');
  const detach = s.attachView(); // the user opens the panel
  assert.equal(s.getSnapshot().ready, false);
  detach();
});

test('NEGATIVE TWIN: a turn that finishes while a view is attached does not raise the ready dot', async () => {
  const f = streamingFetch();
  const s = createChatSession({ fetch: f.fetchImpl, newId: ids });
  const detach = s.attachView(); // Home is on screen
  const turn = s.send('hello');
  await until(() => f.calls.length === 1, 'the request');
  f.push({ type: 'done', content: 'Hi.' });
  f.end();
  await turn;
  assert.equal(s.getSnapshot().ready, false);
  detach();
});

test('path and page context are read at send time, from the page the user is on now', async () => {
  const f = streamingFetch();
  const s = createChatSession({ fetch: f.fetchImpl, newId: ids });
  let where = { path: '/', pageContext: null as unknown };
  s.setContextProvider(() => where);
  const first = s.send('start on Home');
  await until(() => f.calls.length === 1, 'first request');
  f.push({ type: 'done', content: 'ok' });
  f.end();
  await first;
  where = { path: '/data', pageContext: { kind: 'dataset', id: 'ds-1' } }; // the user moved to Data
  const second = s.send('and this dataset?');
  await until(() => f.calls.length === 2, 'second request');
  f.push({ type: 'done', content: 'ok' });
  f.end();
  await second;
  assert.equal(f.calls[0].body.path, '/');
  assert.equal(f.calls[1].body.path, '/data');
  assert.deepEqual(f.calls[1].body.pageContext, { kind: 'dataset', id: 'ds-1' });
  assert.equal(f.calls[0].body.conversationId, f.calls[1].body.conversationId, 'one conversation across pages');
  assert.equal((f.calls[1].body.messages as unknown[]).length, 3);
});

test('a server error marks the question failed, shows a readable message, and retry re-sends it', async () => {
  const f = streamingFetch();
  const s = createChatSession({ fetch: f.fetchImpl, newId: ids });
  const turn = s.send('break please');
  await until(() => f.calls.length === 1, 'the request');
  f.push({ type: 'error', error: 'The model is not reachable right now.' });
  f.end();
  await turn;
  assert.equal(s.getSnapshot().error, 'The model is not reachable right now.');
  assert.equal(s.getSnapshot().messages[0].failed, true);
  const again = s.retry(0);
  await until(() => f.calls.length === 2, 'the retry');
  f.push({ type: 'done', content: 'Fine now.' });
  f.end();
  await again;
  assert.deepEqual(s.getSnapshot().messages.map((m) => m.content), ['break please', 'Fine now.']);
  assert.equal(s.getSnapshot().error, '');
});

test('a non-stream error body becomes a readable sentence, never a raw exception', async () => {
  const fetchImpl = (async () => new Response('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })) as typeof fetch;
  const s = createChatSession({ fetch: fetchImpl, newId: ids });
  await s.send('hi');
  assert.match(s.getSnapshot().error, /unavailable right now \(error 502\)/);
});

test('new chat stops a running turn, and its late events cannot leak into the new conversation', async () => {
  const f = streamingFetch();
  const s = createChatSession({ fetch: f.fetchImpl, newId: ids });
  const turn = s.send('first');
  await until(() => f.calls.length === 1, 'the request');
  const oldId = s.getSnapshot().conversationId;
  s.reset();
  await turn;
  assert.equal(f.calls[0].signal?.aborted, true);
  assert.notEqual(s.getSnapshot().conversationId, oldId);
  assert.equal(s.getSnapshot().messages.length, 0);
  assert.equal(s.getSnapshot().busy, false);
});

test('sign-out stops the turn and forgets the conversation', async () => {
  const f = streamingFetch();
  const s = createChatSession({ fetch: f.fetchImpl, newId: ids });
  const turn = s.send('secret question');
  await until(() => f.calls.length === 1, 'the request');
  s.signOut();
  await turn;
  assert.equal(f.calls[0].signal?.aborted, true);
  assert.equal(s.getSnapshot().messages.length, 0);
});

test('the launcher renders working, ready and idle from store state, and stays hidden on Home and while the panel is open', () => {
  const working = launcherView({ busy: true, ready: false }, '/data', false);
  assert.equal(working.visible, true);
  assert.equal(working.state, 'working');
  assert.equal(working.ariaLabel, 'Ask the OS — working…');
  assert.equal(working.announce, 'Ask the OS — working…');
  const ready = launcherView({ busy: false, ready: true }, '/data', false);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.ariaLabel, 'Ask the OS — answer ready');
  const idle = launcherView({ busy: false, ready: false }, '/metrics', false);
  assert.equal(idle.state, 'idle');
  assert.equal(idle.ariaLabel, 'Ask the OS');
  assert.equal(idle.announce, '');
  assert.equal(launcherView({ busy: true, ready: false }, '/', false).visible, false, 'Home is the surface');
  assert.equal(launcherView({ busy: true, ready: false }, '/data', true).visible, false, 'the open panel replaces the button');
});
