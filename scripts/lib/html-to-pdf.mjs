// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Borek Data Ventures UG
// =============================================================================
// html-to-pdf.mjs — render a local HTML file to a print-grade PDF via headless
// Chrome's DevTools Protocol (CDP). Zero npm dependencies: it uses Node's
// built-in `fetch` + `WebSocket` (Node >= 22) to talk to Chrome directly, so it
// runs fully offline and reproducibly.
//
// Why CDP and not `chrome --print-to-pdf`? Only `Page.printToPDF` exposes
// `displayHeaderFooter` + custom header/footer templates, which is how we get
// real running footers and page numbers. `preferCSSPageSize: true` makes Chrome
// honour the stylesheet's @page rules — including a margin-less @page for the
// cover, which leaves no room for the footer so Chrome omits it there (a clean
// cover with no page number, no merge step required).
//
// Usage:
//   node html-to-pdf.mjs <input.html> <output.pdf> <chrome-binary> \
//     [--title "…"] [--version "…"]
// =============================================================================
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const [, , INPUT, OUTPUT, CHROME, ...rest] = process.argv;
if (!INPUT || !OUTPUT || !CHROME) {
  console.error('usage: html-to-pdf.mjs <input.html> <output.pdf> <chrome> [--title T] [--version V]');
  process.exit(2);
}
const opt = (flag, dflt) => {
  const i = rest.indexOf(flag);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : dflt;
};
const VERSION = opt('--version', '');

const PORT = 9000 + Math.floor(Math.random() * 1000);
const fileUrl = 'file://' + INPUT;

// Footer: thin wordmark left, page number right. Rendered by Chrome in the page
// bottom margin; the cover's margin-less @page suppresses it automatically.
// (Header/footer templates run in an isolated context without our webfonts, so
// they use a restrained system serif — they are tiny page furniture only.)
const footerTemplate = `
  <div style="width:100%;font-family:Georgia,'Times New Roman',serif;font-size:8px;
    color:#8a7f6e;padding:0 20mm;display:flex;justify-content:space-between;
    align-items:center;-webkit-print-color-adjust:exact;">
    <span style="letter-spacing:.14em;text-transform:uppercase;">Sovereign Agentic OS${VERSION ? ' · ' + VERSION : ''}</span>
    <span style="letter-spacing:.06em;"><span class="pageNumber"></span></span>
  </div>`;
// Empty header — we want clean top margins, not a banner on every page.
const headerTemplate = '<div></div>';

async function rpc(ws, pending, method, params = {}, sessionId) {
  const id = rpc.id = (rpc.id || 0) + 1;
  const msg = { id, method, params };
  if (sessionId) msg.sessionId = sessionId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(msg));
  });
}

async function main() {
  // 1. Launch a throwaway headless Chrome with the debugging endpoint open.
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb',
    `--remote-debugging-port=${PORT}`, '--remote-allow-origins=*', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', () => {}); // drain

  // 2. Wait for the DevTools HTTP endpoint to come up, then grab the browser WS.
  let wsUrl = '';
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      wsUrl = (await r.json()).webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  if (!wsUrl) throw new Error('Chrome DevTools endpoint did not come up');

  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  const waiters = []; // event listeners: { method, sessionId, resolve }
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w.method === m.method && (!w.sessionId || w.sessionId === m.sessionId)) {
          waiters.splice(i, 1); w.resolve(m);
        }
      }
    }
  });
  const onceEvent = (method, sessionId) =>
    new Promise((resolve) => waiters.push({ method, sessionId, resolve }));
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  // 3. Open the HTML in a fresh tab, attach a flat session, wait for full load
  //    AND for webfonts to settle (so the print never falls back to a system face).
  const { targetId } = await rpc(ws, pending, 'Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await rpc(ws, pending, 'Target.attachToTarget', { targetId, flatten: true });
  await rpc(ws, pending, 'Page.enable', {}, sessionId);
  const loaded = onceEvent('Page.loadEventFired', sessionId);
  await rpc(ws, pending, 'Page.navigate', { url: fileUrl }, sessionId);
  await loaded;
  await rpc(ws, pending, 'Runtime.evaluate',
    { expression: 'document.fonts.ready.then(()=>true)', awaitPromise: true }, sessionId);
  await sleep(150); // final layout settle

  // 4. Print. preferCSSPageSize honours the stylesheet's @page rules.
  const { data } = await rpc(ws, pending, 'Page.printToPDF', {
    printBackground: true,
    preferCSSPageSize: true,
    displayHeaderFooter: true,
    headerTemplate,
    footerTemplate,
    scale: 1,
  }, sessionId);

  writeFileSync(OUTPUT, Buffer.from(data, 'base64'));
  ws.close();
  chrome.kill();
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('html-to-pdf failed:', e.message);
  process.exit(1);
});
