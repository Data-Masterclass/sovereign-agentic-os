#!/usr/bin/env node
/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG
 *
 * AREA:       repo tooling
 * FEATURE:    The code-map page — one generated HTML page describing every folder
 * USER STORY: As an engineer new to the repo I want to see, in one page, what each folder holds,
 *             what each file is for and which feature it serves, without reading the source first;
 *             as a maintainer I want that page to be generated so it can never drift from the code.
 * ARCHITECTURE:
 *   - Pure read of the working tree: no network, no dependencies, no build step.
 *   - Content comes from the code itself — each file's FEATURE / USER STORY / ARCHITECTURE header
 *     (see scripts/check-structure.mjs), each tab's manifest.ts, each component's UPSTREAM.md.
 *   - Writes docs/site/index.html (self-contained). `--check` exits 1 when that file is stale,
 *     so CI fails on a doc that no longer matches the tree.
 */
import { readFileSync, readdirSync, statSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, basename } from 'node:path';

const OUT = 'docs/site/index.html';
const check = process.argv.includes('--check');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const walk = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir).sort()) {
    if (['node_modules', '.next', 'dist', '.git'].includes(e) || e.startsWith('.')) continue;
    const p = join(dir, e);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
};
const isCode = (f) => /\.(ts|tsx|mjs|js|py|rego)$/.test(f) && !/\.d\.ts$/.test(f);

/** Pull the header fields out of a file's leading comment block. */
function header(file) {
  let head;
  try { head = readFileSync(file, 'utf8').slice(0, 3000); } catch { return null; }
  const field = (name) => {
    const m = head.match(new RegExp(`${name}:\\s*([\\s\\S]*?)(?=\\n\\s*\\*\\s*[A-Z][A-Z ]+:|\\n\\s*\\*/)`));
    if (!m) return '';
    return m[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim()).filter(Boolean).join(' ').trim();
  };
  const feature = field('FEATURE');
  const story = field('USER STORY');
  const arch = field('ARCHITECTURE');
  if (feature || story || arch) return { feature, story, arch, tab: field('TAB') || field('AREA') };
  // Fall back to the first sentence of the leading JSDoc so an un-migrated file still says something.
  const doc = head.match(/\/\*\*?([\s\S]*?)\*\//);
  if (!doc) return null;
  const text = doc[1].split('\n').map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter((l) => l && !l.startsWith('SPDX') && !l.startsWith('Copyright')).join(' ').trim();
  return text ? { feature: '', story: '', arch: text.slice(0, 400), tab: '', legacy: true } : null;
}

const lines = (f) => { try { return readFileSync(f, 'utf8').split('\n').length; } catch { return 0; } };

/** One documented folder. */
function folder(path, { title, blurb = '', meta = [] } = {}) {
  const files = walk(path).filter(isCode);
  const docs = files.map((f) => ({ path: relative(path, f), full: f, lines: lines(f), h: header(f) }));
  return { path, title: title || path, blurb, meta, files: docs,
    loc: docs.reduce((a, b) => a + b.lines, 0), documented: docs.filter((d) => d.h && !d.h.legacy).length };
}

// ---------------------------------------------------------------- gather ----
const sections = [];

// components/: upstream pins, documented by their own UPSTREAM.md
if (existsSync('components')) {
  const items = readdirSync('components').filter((d) => statSync(join('components', d)).isDirectory()).sort();
  sections.push({ kind: 'components', title: 'components/',
    blurb: 'One folder per upstream component the OS deploys. Upstream material only — licence and exact pin; nothing we wrote.',
    items: items.map((d) => {
      const md = join('components', d, 'UPSTREAM.md');
      const text = existsSync(md) ? readFileSync(md, 'utf8') : '';
      const get = (k) => (text.match(new RegExp(`\\*\\*${k}:\\*\\*\\s*(.+)`)) || [, ''])[1].trim();
      return { name: d, licence: get('Licence'), source: get('Source'), pin: get('Pinned as'),
        why: (text.match(/\*\*Why the OS ships it:\*\*\s*([\s\S]*?)\n\n/) || [, ''])[1].trim() };
    }) });
}

// os-ui: the migrated layout if it exists, the current one otherwise
const UI = 'os-ui';
const migrated = existsSync(join(UI, 'core')) && existsSync(join(UI, 'tabs'));
if (migrated) {
  const core = readdirSync(join(UI, 'core')).filter((d) => statSync(join(UI, 'core', d)).isDirectory()).sort();
  sections.push({ kind: 'folders', title: 'os-ui/core/',
    blurb: 'The kernel: everything every tab depends on. Never imports a tab.',
    folders: core.map((d) => folder(join(UI, 'core', d))) });
  const tabs = readdirSync(join(UI, 'tabs')).filter((d) => statSync(join(UI, 'tabs', d)).isDirectory()).sort();
  sections.push({ kind: 'folders', title: 'os-ui/tabs/',
    blurb: 'One folder per tab: pages, API routes, domain logic, MCP tools, policies, guide. A tab imports only the kernel and itself.',
    folders: tabs.map((d) => {
      const man = join(UI, 'tabs', d, 'manifest.ts');
      const meta = [];
      if (existsSync(man)) {
        const t = readFileSync(man, 'utf8');
        const arr = (k) => (t.match(new RegExp(`${k}:\\s*\\[([^\\]]*)\\]`)) || [, ''])[1]
          .split(',').map((x) => x.trim().replace(/['"`]/g, '')).filter(Boolean);
        const one = (k) => (t.match(new RegExp(`${k}:\\s*['"\`]([^'"\`]+)`)) || [, ''])[1];
        meta.push(['feature key', one('key')], ['routes', arr('routes').join(' · ')],
                  ['api', arr('api').join(' · ')], ['mcp tools', arr('mcpTools').join(' · ')],
                  ['services', arr('services').join(' · ')]);
      }
      return folder(join(UI, 'tabs', d), { meta: meta.filter(([, v]) => v) });
    }) });
} else {
  sections.push({ kind: 'folders', title: 'os-ui/ (pre-migration layout)',
    blurb: 'The application. The core / tabs split described in the rework plan has not landed yet, so these are the current folders.',
    folders: ['lib', 'app', 'components'].filter((d) => existsSync(join(UI, d)))
      .flatMap((d) => readdirSync(join(UI, d)).filter((x) => statSync(join(UI, d, x)).isDirectory())
        .map((x) => folder(join(UI, d, x)))) });
}

// the rest of the repo
sections.push({ kind: 'folders', title: 'delivery',
  blurb: 'How the OS is packaged and run.',
  folders: ['charts/sovereign-agentic-os/templates', 'images', 'scripts', 'deploy']
    .filter(existsSync).map((d) => folder(d)) });

// ------------------------------------------------------------------ render --
const totalFiles = sections.flatMap((s) => s.folders || []).reduce((a, f) => a + f.files.length, 0);
const totalLoc = sections.flatMap((s) => s.folders || []).reduce((a, f) => a + f.loc, 0);
const documented = sections.flatMap((s) => s.folders || []).reduce((a, f) => a + f.documented, 0);

const fileRow = (f) => `
  <div class="file" id="${esc(f.full)}">
    <div class="file-h"><code>${esc(f.path)}</code><span class="loc">${f.lines} lines</span></div>
    ${f.h ? `${f.h.feature ? `<p class="feat">${esc(f.h.feature)}</p>` : ''}
    ${f.h.story ? `<p class="story">${esc(f.h.story)}</p>` : ''}
    ${f.h.arch ? `<p class="arch">${esc(f.h.arch)}</p>` : ''}` : '<p class="undoc">No header yet.</p>'}
  </div>`;

const folderBlock = (f) => `
  <section class="folder" id="${esc(f.path)}">
    <h3>${esc(f.title)}</h3>
    <p class="counts">${f.files.length} files · ${f.loc.toLocaleString()} lines · ${f.documented} documented</p>
    ${f.meta.length ? `<dl class="meta">${f.meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
    <div class="files">${f.files.map(fileRow).join('')}</div>
  </section>`;

const sectionBlock = (s) => s.kind === 'components' ? `
  <section class="group" id="${esc(s.title)}">
    <h2>${esc(s.title)}</h2><p class="blurb">${esc(s.blurb)}</p>
    <div class="cards">${s.items.map((c) => `
      <article class="card">
        <h4>${esc(c.name)}</h4>
        <p class="lic">${esc(c.licence)}</p>
        <p>${esc(c.why)}</p>
        <p class="pin"><code>${esc(c.pin.replace(/`/g, ''))}</code></p>
      </article>`).join('')}</div>
  </section>` : `
  <section class="group" id="${esc(s.title)}">
    <h2>${esc(s.title)}</h2><p class="blurb">${esc(s.blurb)}</p>
    ${s.folders.map(folderBlock).join('')}
  </section>`;

const nav = sections.map((s) => `<li><a href="#${esc(s.title)}">${esc(s.title)}</a><ul>${
  (s.folders || s.items || []).map((x) => `<li><a href="#${esc(x.path || x.name)}">${esc(basename(x.path || x.name))}</a></li>`).join('')
}</ul></li>`).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sovereign Agentic OS — Code Map</title>
<style>
:root{--bg:#fbfaf8;--panel:#fff;--ink:#17201c;--muted:#5d6b63;--line:#e2e5e0;--accent:#1f6f4a;--code:#f3f4f1}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#10130f;--panel:#171b16;--ink:#e8eae4;--muted:#9aa89f;--line:#272d26;--accent:#6cc79a;--code:#1d221c}}
:root[data-theme=dark]{--bg:#10130f;--panel:#171b16;--ink:#e8eae4;--muted:#9aa89f;--line:#272d26;--accent:#6cc79a;--code:#1d221c}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
.wrap{display:grid;grid-template-columns:260px minmax(0,1fr);gap:40px;max-width:1240px;margin:0 auto;padding:16px}
nav{position:sticky;top:0;align-self:start;max-height:100vh;overflow:auto;padding-block:32px;font-size:13px}
nav ul{list-style:none;margin:0;padding:0}nav>ul>li{margin-bottom:14px}nav ul ul{padding-left:10px;border-left:1px solid var(--line)}
nav a{color:var(--muted);text-decoration:none;display:block;padding:2px 0}nav a:hover{color:var(--accent)}
main{padding-block:32px;min-width:0}
h1{font-size:30px;letter-spacing:-.02em;margin:0 0 6px;text-wrap:balance}
h2{font-size:21px;margin:48px 0 4px;padding-top:18px;border-top:1px solid var(--line)}
h3{font-size:15px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;margin:26px 0 2px;color:var(--accent)}
h4{margin:0 0 4px;font-size:14px}
.sub{color:var(--muted);margin:0 0 4px}.blurb{color:var(--muted);margin:0 0 8px;max-width:65ch}
.counts{color:var(--muted);font-size:12px;margin:0 0 8px;font-variant-numeric:tabular-nums}
.meta{display:grid;grid-template-columns:auto minmax(0,1fr);gap:2px 12px;margin:0 0 10px;font-size:12.5px}
.meta dt{color:var(--muted)}.meta dd{margin:0;font-family:ui-monospace,Menlo,monospace;word-break:break-word}
.files{display:grid;gap:8px}
.file{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:10px 12px}
.file-h{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.file-h code{font-size:12.5px}.loc{color:var(--muted);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.file p{margin:5px 0 0;font-size:13.5px;max-width:72ch}
.feat{font-weight:600}.story{color:var(--muted)}.arch{color:var(--muted);font-size:13px}
.undoc{color:var(--muted);font-style:italic}
code{background:var(--code);padding:1px 5px;border-radius:4px;font-family:ui-monospace,Menlo,monospace}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:7px;padding:12px}
.card p{margin:3px 0;font-size:13px;color:var(--muted)}.card .lic{color:var(--accent);font-size:12px}
.card .pin code{font-size:11px;word-break:break-all}
.stats{display:flex;gap:22px;flex-wrap:wrap;margin:14px 0 0;font-size:13px;color:var(--muted)}
.stats b{color:var(--ink);font-variant-numeric:tabular-nums}
@media(max-width:860px){.wrap{grid-template-columns:1fr;gap:0}nav{position:static;max-height:none;padding-block:16px}}
</style></head><body><div class="wrap">
<nav><ul>${nav}</ul></nav>
<main>
<h1>Sovereign Agentic OS — Code Map</h1>
<p class="sub">Every folder, what it holds and why. Generated from the source by <code>scripts/build-docs.mjs</code>; the text comes from each file's own header, each tab's manifest and each component's UPSTREAM.md.</p>
<p class="stats"><span><b>${totalFiles.toLocaleString()}</b> source files</span><span><b>${totalLoc.toLocaleString()}</b> lines</span><span><b>${documented.toLocaleString()}</b> with a full header</span><span>generated ${new Date().toISOString().slice(0, 10)}</span></p>
${sections.map(sectionBlock).join('')}
</main></div></body></html>`;

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, 'utf8') : '';
  const strip = (s) => s.replace(/generated \d{4}-\d{2}-\d{2}/, '');
  if (strip(current) !== strip(html)) { console.error(`${OUT} is stale — run: node scripts/build-docs.mjs`); process.exit(1); }
  console.log(`${OUT} is up to date`); process.exit(0);
}
mkdirSync('docs/site', { recursive: true });
writeFileSync(OUT, html);
console.log(`${OUT}: ${totalFiles} files, ${totalLoc} lines, ${documented} fully documented`);
