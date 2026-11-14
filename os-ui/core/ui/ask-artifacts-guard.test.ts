/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * FEATURE:    The chat/artifact path renders no model-authored markup or code (C10).
 *
 * USER STORY: As a security reviewer I want a mechanical guarantee that nothing on the
 *             Ask-the-OS path can render HTML, SVG or JS that a model — or a row of data a
 *             model read — authored, so the obvious "let the model draw the chart" shortcut
 *             cannot be taken without failing a test.
 *
 * ARCHITECTURE:
 *   The baseline is CLEAN today (react-markdown, no `dangerouslySetInnerHTML` on this path).
 *   This test's job is to keep it that way, which means it must fail on a change, not merely
 *   describe the present. It scans a PATH-SCOPED file list — every module the chat turn and
 *   the artifact renderers touch — for:
 *     • `dangerouslySetInnerHTML` — React's own docs: "it is trivial to introduce an XSS
 *       vulnerability this way";
 *     • `eval(` and `new Function(` — arbitrary code from a string;
 *     • `srcdoc` / `<iframe` — the Open WebUI/LibreChat artifacts model we deliberately did
 *       not adopt, and the `allow-scripts` + `allow-same-origin` trap that comes with it;
 *     • an `href`/`src` taken from an artifact field, which is how a model-supplied URL
 *       becomes an open redirect or an exfiltration channel.
 *
 *   The FILE LIST is itself an assertion, in BOTH directions: every path on it must exist,
 *   and — review M-1 — every `core/ui/Ask*.{ts,tsx}` file on disk must be ON it. A hardcoded
 *   list is a guard that stops guarding the moment someone adds `AskCharts.tsx`, which is
 *   precisely when it is needed; the glob closes that door. Modules outside the naming
 *   convention are still listed explicitly, because a convention cannot cover the route or
 *   the harness.
 */

const UI = join(import.meta.dirname, '..', '..');

/** Every module on the Ask-the-OS chat + artifact path. Keep in step with the surface. */
const CHAT_PATH_FILES = [
  // the turn
  'core/runtime/agent-loop.ts',
  'core/runtime/agentic.ts',
  'core/runtime/ask-rules.ts',
  'core/runtime/ask-response.ts',
  'app/api/assistant/chat/route.ts',
  // the artifact protocol
  'core/runtime/chat-artifacts.ts',
  // the surface
  'core/ui/OsAssistant.tsx',
  'core/ui/AskArtifacts.tsx',
  'core/ui/ask-artifacts.ts',
  'core/ui/Markdown.tsx',
];

const FORBIDDEN: { pattern: RegExp; why: string }[] = [
  {
    pattern: /dangerouslySetInnerHTML/,
    why: 'renders a string as markup — React\'s docs call this trivially exploitable. An artifact carries DATA; render it as a text node.',
  },
  { pattern: /\beval\s*\(/, why: 'executes a string as code' },
  { pattern: /new\s+Function\s*\(/, why: 'compiles a string into code' },
  {
    pattern: /srcdoc/,
    why: 'the model-authored-HTML-in-an-iframe model (Open WebUI / LibreChat artifacts). For DATA charts the right answer is to not have the problem: typed rows + a vetted chart component.',
  },
  {
    pattern: /<iframe/i,
    why: 'an iframe on the chat path invites `allow-scripts` + `allow-same-origin`, which per MDN lets the frame remove its own sandbox — no more secure than no sandbox at all',
  },
  {
    pattern: /\bdocument\.write\b/,
    why: 'writes unparsed markup into the document',
  },
  {
    pattern: /insertAdjacentHTML|\.outerHTML\s*=|\.innerHTML\s*=/,
    why: 'assigns markup directly to the DOM',
  },
];

function read(rel: string): string {
  const p = join(UI, rel);
  assert.ok(existsSync(p), `${rel} is on the guard's file list but does not exist — update the list, do not drop the guard`);
  return readFileSync(p, 'utf8');
}

/** Strip block + line comments so the guard's own prose cannot trip it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('C10: no dangerouslySetInnerHTML, eval, new Function or iframe on the chat/artifact path', () => {
  const found: string[] = [];
  for (const rel of CHAT_PATH_FILES) {
    const body = code(read(rel));
    for (const { pattern, why } of FORBIDDEN) {
      if (pattern.test(body)) found.push(`${rel}: ${pattern} — ${why}`);
    }
  }
  assert.deepEqual(found, [], `forbidden rendering primitive on the chat path:\n${found.join('\n')}`);
});

test('C10: the renderer never takes an href or src from an artifact field', () => {
  const body = code(read('core/ui/AskArtifacts.tsx'));
  // The only `href=` in the renderer is the one from our fixed route map.
  const hrefs = body.match(/href=\{[^}]*\}/g) ?? [];
  for (const h of hrefs) {
    assert.match(h, /href=\{href\}/, `an href must come from citationHref(), not from the payload: ${h}`);
  }
  assert.equal((body.match(/src=\{/g) ?? []).length, 0, 'no src is ever taken from a payload');
  assert.equal((body.match(/style=\{/g) ?? []).length, 0, 'no inline style is ever taken from a payload');
});

test('C10: the href map is a closed set of in-app routes, never a model-supplied URL', () => {
  const body = read('core/ui/ask-artifacts.ts');
  const fn = body.slice(body.indexOf('export function citationHref'));
  const end = fn.indexOf('\n}');
  const returns = fn.slice(0, end).match(/return\s+('[^']*'|null)/g) ?? [];
  assert.ok(returns.length >= 3, 'the route map must be explicit');
  for (const r of returns) {
    assert.ok(/'\/[a-z]+'|null/.test(r), `citationHref returned something that is not an in-app path: ${r}`);
    assert.equal(/https?:|javascript:|data:/.test(r), false, `an absolute or scheme URL in the route map: ${r}`);
  }
});

test('C10: the artifact protocol declares no field that could carry markup or a URL', () => {
  const body = read('core/runtime/chat-artifacts.ts');
  // A field named like markup or a link is how "just let the model send HTML" arrives.
  for (const bad of ['html', 'markup', 'svg', 'script', 'href', 'src', 'style', 'url']) {
    const decl = new RegExp(`^\\s*${bad}\\??:`, 'im');
    assert.equal(decl.test(body), false, `the artifact protocol declares a \`${bad}\` field — artifacts carry data, not markup or links`);
  }
});

test('C10: the drawer renders assistant prose through the ONE vetted markdown renderer', () => {
  const drawer = code(read('core/ui/OsAssistant.tsx'));
  assert.match(drawer, /<Markdown>/, 'assistant text must go through core/ui/Markdown');
  const md = code(read('core/ui/Markdown.tsx'));
  // react-markdown is safe by default; `rehype-raw` / `allowDangerousHtml` would undo that.
  assert.equal(/rehype-raw|allowDangerousHtml|skipHtml\s*=\s*\{?false/.test(md), false, 'raw HTML must stay disabled in the markdown renderer');
});

test('C10: the guard covers the whole surface — every path on the list is a real file', () => {
  for (const rel of CHAT_PATH_FILES) assert.ok(existsSync(join(UI, rel)), `${rel} missing`);
  assert.ok(CHAT_PATH_FILES.includes('core/ui/AskArtifacts.tsx'), 'the artifact renderer must be in scope');
  assert.ok(CHAT_PATH_FILES.includes('app/api/assistant/chat/route.ts'), 'the chat route must be in scope');
});

test('C10 (M-1): every core/ui/Ask*.{ts,tsx} on disk is ON the guard list', () => {
  // The other direction of the assertion: a NEW Ask-surface module (AskCharts.tsx, say) is
  // exactly when this guard matters, and a hardcoded list would silently stop covering the
  // surface the moment one is added. Test files are excluded — they are the guard, not the
  // guarded.
  const found = readdirSync(join(UI, 'core', 'ui'))
    .filter((f) => /^Ask.*\.(ts|tsx)$/i.test(f) || /^ask-.*\.(ts|tsx)$/i.test(f))
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .map((f) => `core/ui/${f}`);
  assert.ok(found.length >= 2, `expected the Ask surface modules, found ${found.join(', ') || 'none'}`);
  const missing = found.filter((f) => !CHAT_PATH_FILES.includes(f));
  assert.deepEqual(
    missing,
    [],
    `new Ask-surface module(s) not covered by the C10 guard — add them to CHAT_PATH_FILES: ${missing.join(', ')}`,
  );
});
