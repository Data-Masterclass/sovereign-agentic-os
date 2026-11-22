/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * AREA:       models
 * FEATURE:    Tests for the image allowlist (`canReceiveImages`)
 * USER STORY: As a platform admin I want proof that only the models I listed may be sent images:
 *             not an unknown model, not a look-alike name, and not "everything" because my
 *             override had a typo.
 * ARCHITECTURE:
 *   - Behaviour: the built-in list, exact matching, and every override shape (valid, unset,
 *     empty, malformed, whitespace, case, mixed), driven through `process.env` because the
 *     decision function deliberately takes no list argument.
 *   - Source-level: `canReceiveImages` is the only exported yes/no in the module, the module
 *     uses no substring/regex matching and imports nothing, and no other file under core/,
 *     tabs/ or app/ exports an image-capability predicate or reads the override.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  canReceiveImages,
  modelCapabilities,
  imageAllowlist,
  parseImageAllowlist,
  DEFAULT_IMAGE_MODELS,
  IMAGE_ALLOWLIST_ENV,
} from '@core/models/capabilities';

const ENV = IMAGE_ALLOWLIST_ENV;
const original = process.env[ENV];
const setEnv = (v: string | undefined) => {
  if (v === undefined) delete process.env[ENV];
  else process.env[ENV] = v;
};
afterEach(() => setEnv(original));

/** Run `fn` with console.warn captured; returns what was logged. */
function captureWarnings(fn: () => void): string[] {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { seen.push(a.map(String).join(' ')); };
  try { fn(); } finally { console.warn = orig; }
  return seen;
}

// ------------------------------------------------------------------ defaults --

test('the env var is MODEL_IMAGE_ALLOWLIST', () => {
  assert.equal(ENV, 'MODEL_IMAGE_ALLOWLIST');
});

test('default: exactly the strong role and the old names that resolve to it may receive images', () => {
  setEnv(undefined);
  assert.deepEqual([...DEFAULT_IMAGE_MODELS].sort(), [
    'sovereign-premium',
    'sovereign-reasoning',
    'sovereign-reasoning-fast',
    'sovereign-strong',
    'sovereign-vision',
  ]);
  for (const m of DEFAULT_IMAGE_MODELS) assert.equal(canReceiveImages(m), true, m);
  assert.deepEqual(imageAllowlist(), { models: DEFAULT_IMAGE_MODELS, source: 'default', warnings: [] });
});

test('default: the text-only and embedding aliases may not', () => {
  setEnv(undefined);
  for (const m of ['sovereign-worker', 'sovereign-embedding', 'sovereign-default', 'sovereign-mock', 'sovereign-embed', 'gpt-oss', 'gpt-oss-20b']) {
    assert.equal(canReceiveImages(m), false, m);
  }
});

test('the default list cannot be mutated at runtime', () => {
  assert.throws(() => (DEFAULT_IMAGE_MODELS as string[]).push('sovereign-default'));
  setEnv(undefined);
  assert.equal(canReceiveImages('sovereign-default'), false);
});

// ------------------------------------------------- unknown + look-alike names --

test('an unknown model never receives images', () => {
  setEnv(undefined);
  for (const m of ['some-mystery-model', 'local-qwen', 'private-self-hosted-a', 'gpt-4o', 'claude']) {
    assert.equal(canReceiveImages(m), false, m);
  }
});

test('a name that merely LOOKS vision-capable never receives images (no substring match)', () => {
  setEnv(undefined);
  const lookAlikes = [
    'vl', 'my-vl-model', 'qwen3-vl', 'Qwen3-VL-235B', 'qwen', 'vision', 'acme-vision', 'llava-vision-7b',
    'sovereign-vision-2', 'sovereign-vision-preview', 'x-sovereign-vision', 'sovereign-visio',
    'sovereign-reasoning-fast-2', 'sovereign-reasoning-', 'my-sovereign-reasoning',
    // the upstream id and the display name are NOT the gateway alias
    'openai/Qwen/Qwen3-VL-235B-A22B-Instruct-FP8', 'Qwen/Qwen3-VL-235B-A22B-Instruct-FP8',
  ];
  for (const m of lookAlikes) assert.equal(canReceiveImages(m), false, m);
});

test('matching is exact: other casing or padding is a different name', () => {
  setEnv(undefined);
  for (const m of ['Sovereign-Vision', 'SOVEREIGN-REASONING', ' sovereign-vision', 'sovereign-vision ', 'sovereign-vision\n']) {
    assert.equal(canReceiveImages(m), false, JSON.stringify(m));
  }
});

test('a role name is not a model: callers must pass the resolved alias', () => {
  setEnv(undefined);
  for (const role of ['reasoning', 'standard', 'tools', 'embeddings', 'coder', 'vision']) {
    assert.equal(canReceiveImages(role), false, role);
  }
});

test('empty, non-string and prototype-key inputs are false', () => {
  setEnv(undefined);
  for (const m of ['', '*', 'constructor', '__proto__', 'toString', 'length', 'includes', '0']) {
    assert.equal(canReceiveImages(m), false, m);
  }
  for (const m of [undefined, null, 0, true, {}, ['sovereign-vision']]) {
    assert.equal(canReceiveImages(m as unknown as string), false, String(m));
  }
});

test('modelCapabilities reports the same answer as canReceiveImages', () => {
  setEnv(undefined);
  assert.deepEqual(modelCapabilities('sovereign-vision'), { images: true });
  assert.deepEqual(modelCapabilities('sovereign-default'), { images: false });
  assert.deepEqual(modelCapabilities('nope'), { images: false });
});

// ---------------------------------------------------------- override parsing --

test('override (valid): REPLACES the default list — it can add AND remove', () => {
  const r = parseImageAllowlist('["sovereign-vision","my-eu-vlm"]');
  assert.deepEqual(r, { models: ['sovereign-vision', 'my-eu-vlm'], source: 'override', warnings: [] });

  setEnv('["sovereign-vision","my-eu-vlm"]');
  assert.equal(canReceiveImages('sovereign-vision'), true);
  assert.equal(canReceiveImages('my-eu-vlm'), true);
  // on the default list, but removed by the override
  assert.equal(canReceiveImages('sovereign-reasoning'), false);
  assert.equal(canReceiveImages('sovereign-premium'), false);
  assert.equal(canReceiveImages('sovereign-reasoning-fast'), false);
});

test('override is read on every call (no stale copy)', () => {
  setEnv('["only-this"]');
  assert.equal(canReceiveImages('only-this'), true);
  setEnv(undefined);
  assert.equal(canReceiveImages('only-this'), false);
  assert.equal(canReceiveImages('sovereign-vision'), true);
});

test('override (unset / blank): the default list, silently', () => {
  for (const raw of [undefined, '', '   ', '\n\t']) {
    assert.deepEqual(parseImageAllowlist(raw), { models: DEFAULT_IMAGE_MODELS, source: 'default', warnings: [] });
  }
  setEnv('  ');
  const logged = captureWarnings(() => assert.equal(canReceiveImages('sovereign-vision'), true));
  assert.deepEqual(logged, []);
});

test('override ([]): an explicit empty list means NO model receives images', () => {
  assert.deepEqual(parseImageAllowlist('[]'), { models: [], source: 'override', warnings: [] });
  assert.deepEqual(parseImageAllowlist(' [ ] '), { models: [], source: 'override', warnings: [] });
  setEnv('[]');
  for (const m of [...DEFAULT_IMAGE_MODELS, 'sovereign-default', 'anything']) {
    assert.equal(canReceiveImages(m), false, m);
  }
});

test('override (malformed): the default list with a warning — never "allow all"', () => {
  const malformed = [
    'sovereign-vision',                       // a bare name, not JSON
    'sovereign-vision,sovereign-reasoning',   // comma list, not JSON
    '["sovereign-vision"',                    // truncated
    '{"sovereign-vision":true}',              // an object, not an array
    '"sovereign-vision"',                     // a string, not an array
    'true', 'null', '1', '*', '"*"',
    '[1,2,3]', '[null]', '[""]', '["  "]', '[[],{}]', '[true]',
  ];
  for (const raw of malformed) {
    const r = parseImageAllowlist(raw);
    assert.equal(r.source, 'default', raw);
    assert.equal(r.models, DEFAULT_IMAGE_MODELS, raw);
    assert.equal(r.warnings.length, 1, raw);

    setEnv(raw);
    const logged = captureWarnings(() => {
      assert.equal(canReceiveImages('sovereign-vision'), true, raw);
      assert.equal(canReceiveImages('sovereign-default'), false, `${raw} must not allow a text model`);
      assert.equal(canReceiveImages('some-mystery-model'), false, `${raw} must not allow an unknown model`);
    });
    assert.equal(logged.length, 1, `${raw} is logged`);
  }
});

test('there is no wildcard: "*" in a list is just a name no model has', () => {
  setEnv('["*"]');
  assert.equal(canReceiveImages('sovereign-vision'), false);
  assert.equal(canReceiveImages('sovereign-default'), false);
  assert.equal(canReceiveImages('anything'), false);
  assert.equal(canReceiveImages('*'), true); // the literal name only
});

test('override (whitespace): entries are trimmed and de-duplicated', () => {
  const r = parseImageAllowlist(' [ "  sovereign-vision ", "my-vlm\\n", "sovereign-vision" ] ');
  assert.deepEqual(r, { models: ['sovereign-vision', 'my-vlm'], source: 'override', warnings: [] });
});

test('override (case): case is kept and matching stays case-sensitive', () => {
  setEnv('["My-VLM"]');
  assert.equal(canReceiveImages('My-VLM'), true);
  assert.equal(canReceiveImages('my-vlm'), false);
  assert.equal(canReceiveImages('MY-VLM'), false);
  setEnv('["Sovereign-Vision"]');
  assert.equal(canReceiveImages('sovereign-vision'), false);
});

test('override (mixed): usable names apply, the rest are skipped with a warning', () => {
  const r = parseImageAllowlist('["sovereign-vision", 7, "", null, {"a":1}]');
  assert.deepEqual(r.models, ['sovereign-vision']);
  assert.equal(r.source, 'override');
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /4 entries were not a model name/);
});

test('a bad override is logged once per value, not on every lookup', () => {
  setEnv('not json — logged once');
  const logged = captureWarnings(() => {
    canReceiveImages('sovereign-vision');
    canReceiveImages('sovereign-default');
    imageAllowlist();
  });
  assert.equal(logged.length, 1);
  assert.match(logged[0], /MODEL_IMAGE_ALLOWLIST is not valid JSON/);
  assert.match(logged[0], /built-in image list is in use/);
});

// ------------------------------------------------------- source-level guards --

const ROOT = process.cwd(); // os-ui/
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.next' || e.name.startsWith('.')) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) sourceFiles(rel, out);
    else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(rel);
  }
  return out;
}

test('SOURCE: capabilities.ts exports one decision function, and it is canReceiveImages', () => {
  const src = read('core/models/capabilities.ts');
  const exported = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]).sort();
  assert.deepEqual(exported, ['canReceiveImages', 'imageAllowlist', 'modelCapabilities', 'parseImageAllowlist']);
  // the only exported function that answers yes/no
  const booleans = [...src.matchAll(/^export (?:async )?function (\w+)\([^)]*\): boolean/gm)].map((m) => m[1]);
  assert.deepEqual(booleans, ['canReceiveImages']);
  // it takes the model and nothing else — a caller cannot bring its own list
  assert.match(src, /^export function canReceiveImages\(model: string\): boolean \{$/m);
  // the listing shape is built on it, not on a second rule
  assert.match(src, /export function modelCapabilities\(model: string\): ModelCapabilities \{\n\s+return \{ images: canReceiveImages\(model\) \};\n\}/);
  // exact membership only: no substring, prefix, regex or case-folding in the module
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const banned of ['.startsWith(', '.endsWith(', '.toLowerCase(', '.toUpperCase(', '.match(', '.test(', 'new RegExp', '.indexOf(', '.search(']) {
    assert.equal(code.includes(banned), false, `capabilities.ts must not use ${banned}`);
  }
});

test('SOURCE: no second image-capability predicate, and no second reader of the allowlist, anywhere in os-ui', () => {
  const PREDICATE = /export (?:async )?(?:function|const) ((?:can|may|supports?|accepts?|allows?|has)\w*(?:Images?|Vision|Multimodal)\w*|is(?:Vision|Multimodal|ImageCapable)\w*)\b/g;
  const predicates: string[] = [];
  const envReaders: string[] = [];
  for (const file of ['core', 'tabs', 'app'].flatMap((d) => sourceFiles(d))) {
    const src = read(file);
    for (const m of src.matchAll(PREDICATE)) predicates.push(`${file}: ${m[1]}`);
    if (src.includes('MODEL_IMAGE_ALLOWLIST')) envReaders.push(file);
  }
  assert.deepEqual(predicates, ['core/models/capabilities.ts: canReceiveImages']);
  assert.deepEqual(envReaders, ['core/models/capabilities.ts']);
});

test('SOURCE: the tier guess in routing.ts is not wired to the image decision', () => {
  const routing = read('tabs/agents/lib/routing.ts');
  assert.equal(/from ['"][^'"]*models\/capabilities['"]/.test(routing), false, 'routing.ts must not import the capability map');
  assert.match(routing, /decided only by `canReceiveImages`/, 'tierOf carries the warning that it is a display guess');
  const caps = read('core/models/capabilities.ts');
  const imports = [...caps.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['@core/models/role-names'], 'capabilities.ts imports only the pure role names (core must not import a tab; no guess can leak in)');
});
