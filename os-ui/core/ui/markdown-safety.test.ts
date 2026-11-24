/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:      Model-output markdown never auto-loads external resources
 * USER STORY:   As a user reading an assistant answer, nothing in it makes my browser contact another
 *               site without my click.
 * ARCHITECTURE: Renders the REAL react-markdown + remark-gfm pipeline with the same options as
 *               core/ui/Markdown.tsx (skipHtml + SAFE_MARKDOWN_COMPONENTS) to static HTML and asserts
 *               on the output; plus a tripwire that Markdown.tsx keeps using exactly that wiring and
 *               that no other UI file renders react-markdown directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SAFE_MARKDOWN_COMPONENTS, displayHost, isSameOriginRelative } from '@core/ui/markdown-safety';

const OSUI = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const render = (md: string): string =>
  renderToStaticMarkup(
    createElement(ReactMarkdown, { remarkPlugins: [remarkGfm], skipHtml: true, components: SAFE_MARKDOWN_COMPONENTS }, md),
  );

/** Every <img src="…"> in the HTML. */
const imgSrcs = (html: string): string[] => [...html.matchAll(/<img\b[^>]*\bsrc="([^"]*)"/g)].map((m) => m[1]);

test('an external markdown image is never rendered as <img>', () => {
  for (const md of [
    '![x](https://example.com/p.png?d=secret)',
    '![](http://example.com/a.gif)',
    '![x](//example.com/a.png)',
    '![x][r]\n\n[r]: https://example.com/ref.png',
    '![x](HTTPS://Example.com/a.png)',
  ]) {
    const html = render(md);
    assert.deepEqual(imgSrcs(html), [], `no <img> for ${md}: ${html}`);
    assert.doesNotMatch(html, /<img/i, md);
  }
});

test('a backslash path cannot reach another host', () => {
  // remark percent-encodes the backslash, so the browser sees a same-origin path, never //host.
  for (const src of imgSrcs(render('![x](/\\example.com/a.png)'))) {
    assert.ok(src.startsWith('/') && !src.startsWith('//') && !src.includes('\\'), src);
  }
});

test('an external image becomes a click-only text link showing the host', () => {
  const html = render('![chart](https://example.com/p.png?d=secret)');
  assert.match(html, /\[image: chart — example\.com\]/);
  assert.match(html, /<a [^>]*class="md-blocked-image"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /target="_blank"/);
});

test('a same-origin relative image still renders', () => {
  const html = render('![thumb](/api/files/abc/raw)');
  assert.deepEqual(imgSrcs(html), ['/api/files/abc/raw']);
  assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/i);
});

test('raw HTML images (and other raw HTML) are stripped', () => {
  for (const md of [
    '<img src="https://example.com/x.png">',
    'text <img src="https://example.com/x.png" /> more',
    '<p><img src=https://example.com/x.png></p>',
    '<video src="https://example.com/v.mp4"></video>',
    '<iframe src="https://example.com/"></iframe>',
  ]) {
    const html = render(md);
    assert.doesNotMatch(html, /<(img|video|iframe|audio|source)\b/i, `${md} → ${html}`);
  }
});

test('external links need a click, carry a safe rel, open a new tab and show the host', () => {
  const html = render('[read more](https://docs.example.org/page?q=1)');
  assert.match(html, /href="https:\/\/docs\.example\.org\/page\?q=1"/);
  assert.match(html, /target="_blank"/);
  assert.match(html, /rel="noopener noreferrer nofollow"/);
  assert.match(html, /\(docs\.example\.org\)/);
  // A bare autolink already shows its host — not repeated.
  const auto = render('see https://docs.example.org/x');
  assert.doesNotMatch(auto, /md-link-host/);
});

test('javascript: links are neutralised by the url transform', () => {
  const html = render('[x](javascript:alert(1))');
  assert.doesNotMatch(html, /javascript:/i);
});

test('URL classification helpers', () => {
  assert.equal(isSameOriginRelative('/a/b.png'), true);
  assert.equal(isSameOriginRelative('a/b.png'), true);
  assert.equal(isSameOriginRelative('//evil.example/x'), false);
  assert.equal(isSameOriginRelative('/\\evil.example/x'), false);
  assert.equal(isSameOriginRelative(' https://evil.example/x'), false);
  assert.equal(isSameOriginRelative('data:image/png;base64,AAAA'), false);
  assert.equal(isSameOriginRelative('java\nscript:alert(1)'), false);
  assert.equal(displayHost('https://a.example.com:8443/x'), 'a.example.com:8443');
  assert.equal(displayHost('//b.example.com/x'), 'b.example.com');
});

test('Markdown.tsx uses the safe wiring and is the only react-markdown renderer in the UI', () => {
  const src = readFileSync(join(OSUI, 'core/ui/Markdown.tsx'), 'utf8');
  assert.match(src, /\bskipHtml\b/);
  assert.match(src, /a:\s*SafeLink/);
  assert.match(src, /img:\s*SafeImage/);
  assert.doesNotMatch(src, /rehype-raw|allowDangerousHtml/);

  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e) && !/\.test\.ts$/.test(e)) {
        const s = readFileSync(p, 'utf8');
        if (/from ['"]react-markdown['"]|rehype-raw/.test(s) && !p.endsWith(join('core', 'ui', 'Markdown.tsx'))) {
          offenders.push(p.slice(OSUI.length + 1));
        }
      }
    }
  };
  for (const d of ['app', 'core', 'tabs']) walk(join(OSUI, d));
  assert.deepEqual(offenders, [], 'render model output through @core/ui/Markdown');
});
