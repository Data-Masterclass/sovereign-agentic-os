// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
//
// Drives the Home chat in headless Chrome (DevTools protocol, no extra dependency) against a running
// os-ui: log in as robin, ask, confirm cards, Save as, history; then user ben tries robin's
// conversation through the API. Usage: node live-shots.mjs <base-url> <out-dir>
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
const [base, out] = [process.argv[2], process.argv[3]];
mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = { 'content-type': 'application/json', origin: base, 'sec-fetch-site': 'same-origin' };

async function login(username) {
  const r = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: same, body: JSON.stringify({ username, password: 'Str0ng-Pass-1' }) });
  if (!r.ok) throw new Error(`login ${username}: ${r.status}`);
  const nv = r.headers.getSetCookie()[0].split(';')[0];
  await fetch(`${base}/api/auth/onboarded`, { method: 'POST', headers: { ...same, cookie: nv }, body: '{}' });
  return nv;
}

const robin = await login('robin@demo.example');
const port = 9300 + Math.floor(Math.random() * 500);
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', `--remote-debugging-port=${port}`, '--no-first-run', `--user-data-dir=/tmp/hc-live-${port}`, 'about:blank'], { stdio: 'ignore' });
await sleep(2500);
const tabs = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const ws = new WebSocket(tabs.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((s) => (ws.onopen = s));
let id = 0; const pend = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) pend.get(d.id)(d.result); };
const cmd = (method, params = {}) => new Promise((s) => { const n = ++id; pend.set(n, s); ws.send(JSON.stringify({ id: n, method, params })); });
const js = async (expr) => (await cmd('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.value;
const shot = async (name) => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); writeFileSync(`${out}/${name}.png`, Buffer.from(r.data, 'base64')); console.log('shot', name); };
const waitFor = async (expr, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await js(expr)) return true; await sleep(250); } await shot('timeout').catch(() => {}); throw new Error(`timeout waiting for ${expr}`); };

await cmd('Network.enable');
const [cname, cval] = [robin.split('=')[0], robin.slice(robin.indexOf('=') + 1)];
await cmd('Network.setCookie', { name: cname, value: cval, url: base });
await cmd('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
await cmd('Page.navigate', { url: `${base}/` });
await waitFor(`!!document.querySelector('.hc-input')`);
await sleep(4000); // React must have hydrated before the first keypress counts

async function ask(text) {
  await js(`document.querySelector('.hc-input').focus()`);
  await cmd('Input.insertText', { text });
  await sleep(300);
  await cmd('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cmd('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
const idle = `!document.querySelector('.hc-working') && document.querySelectorAll('.hc-msg.hc-assistant').length>=1`;

// 1. a real answer with a tool step; watch the streamed draft grow
await ask('Who am I and what can I do?');
let drafts = [];
for (let i = 0; i < 120; i++) { const d = await js(`document.querySelector('.hc-draft')?.innerText ?? ''`); if (d && drafts.at(-1) !== d) drafts.push(d); if (await js(idle)) break; await sleep(100); }
console.log('streamed draft frames:', drafts.length, JSON.stringify(drafts.slice(0, 3)));
await waitFor(idle);
await js(`document.querySelector('.hc-step summary')?.click()`);
await sleep(300);
await shot('1-answer-and-tool-step');

// 2. Save as agent (the only kind a creator is offered) -> a confirm card (nothing created yet)
await waitFor(`!!document.querySelector('.hc-saveas-btn')`);
console.log('save-as kinds:', await js(`[...document.querySelectorAll('.hc-saveas-btn')].map(b=>b.textContent).join(',')`));
await js(`[...document.querySelectorAll('.hc-saveas-btn')].find(b=>b.textContent==='Agent')?.click()`);
await waitFor(`!!document.querySelector('.hc-confirm')`);
await sleep(500);
await shot('2-save-as-confirm-card');

// 3. a write asked in plain words -> a confirm card
await js(`[...document.querySelectorAll('.hc-new')].find(b=>b.textContent==='New chat')?.click()`);
await sleep(400);
await ask('Create a data product called orders_demo');
await waitFor(`!!document.querySelector('.hc-confirm')`);
await sleep(500);
await shot('3-write-confirm-card');
const conv = await js(`fetch('/api/assistant/conversations').then(r=>r.json())`);
console.log('robin conversations:', JSON.stringify(conv.conversations.map((c) => ({ id: c.id, title: c.title }))));

// 4. history list
await js(`location.reload()`);
await waitFor(`!!document.querySelector('.hc-input')`);
await sleep(3000);
await waitFor(`[...document.querySelectorAll('.hc-new')].some(b=>b.textContent.startsWith('History'))`);
await js(`[...document.querySelectorAll('.hc-new')].find(b=>b.textContent.startsWith('History'))?.click()`);
await sleep(500);
await shot('4-history');

// 5. another user cannot list, read or continue robin's conversation (API)
const ben = await login('ben@demo.example');
const cid = conv.conversations[0].id;
const get = (p, init = {}) => fetch(`${base}${p}`, { ...init, headers: { ...same, cookie: ben, ...(init.headers ?? {}) } });
const list = await (await get('/api/assistant/conversations')).json();
const read = await get(`/api/assistant/conversations/${cid}`);
const cont = await get('/api/assistant/chat', { method: 'POST', body: JSON.stringify({ path: '/', conversationId: cid, messages: [{ role: 'user', content: 'hello' }] }) });
console.log('BEN list:', JSON.stringify(list), '| read:', read.status, '| continue:', cont.status);

chrome.kill();
process.exit(0);
