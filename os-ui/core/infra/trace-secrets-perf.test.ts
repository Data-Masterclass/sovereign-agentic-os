/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The secret scrubber is linear — it never blocks the event loop on an adversarial input
 * USER STORY: As an operator I want a connection tool result, an external MCP error or a Langfuse export
 *             of any shape to be scrubbed in bounded time, so one large or hostile payload cannot stall
 *             every request on the pod; and I want what was not scanned withheld, never passed through.
 * ARCHITECTURE: pure functions (`core/infra/trace-masking.ts`), timed with `performance.now()`. Linearity is
 *   measured, not a wall-clock budget: each adversarial input is built at two sizes, the second twice the first,
 *   and (after one warm-up call) the minimum of 5 runs at the large size must stay under SCALE_MAX (3×) the
 *   minimum at the small one — linear work grows ~2×, a quadratic path ~4× — through every SECRET_PATTERNS
 *   regex and `scrubSecrets` on the full text (200 KB → 400 KB, the uncapped repository-read path) AND through
 *   `redactSecrets` (32 KB → 64 KB, inside its per-string cap REDACT_MAX_SCAN_CHARS, so the cap cannot hide a
 *   superlinear scan; 200 KB is then a ceiling check). A loaded machine slows both sizes alike, so the ratio
 *   holds where a fixed 100 ms budget flaked (the full suite alongside pushed single inputs to 112–200 ms); a
 *   ratio breach is re-measured and fails only when it repeats. Below NOISE_FLOOR_MS (half the old 100 ms
 *   budget) the ratio is timer noise and is not judged; CEILING_MS (2 s) is a loose absolute backstop on every
 *   timed call (the regressions this guards against took 13.8 s and 31.7 s on 200 KB). Includes the independent
 *   verifier's probes (probe3 / probe4 / probe5) and the fail-open cases of probe3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, REDACT_MAX_SCAN_CHARS, SECRET_PATTERNS, redactSecrets, redactSecretText, scrubSecrets } from '@core/infra/trace-masking';

const KB = 1024;
const KB200 = 200 * KB;
/** Large-over-small time for 2× the input: linear ≈ 2, quadratic ≈ 4. */
const SCALE_MAX = 3;
/** Below this the large-size time is too small for a ratio to mean anything (and is no stall). */
const NOISE_FLOOR_MS = 50;
/** Loose absolute backstop on any single timed call — far above linear even on a loaded runner. */
const CEILING_MS = 2000;
const fill = (unit: string, size = KB200) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const b64 = (n: number) => Buffer.from('y'.repeat(Math.ceil((n * 3) / 4))).toString('base64').slice(0, n);

/** Adversarial inputs of n characters: runs that made a pattern restart at every offset, repeats, nesting. */
const ADVERSARIAL: Record<string, (n: number) => string> = {
  backslashes: (n) => fill('\\', n),
  backslashQuote: (n) => fill('\\"', n),
  letters: (n) => fill('a', n),
  base64: (n) => b64(n),
  passwordRepeated: (n) => fill('password=', n),
  passwordBackslashes: (n) => 'password=' + fill('\\', n),
  passwordQuotedBackslashes: (n) => 'password: \\' + fill('\\', n) + 'x',
  nestedQuotes: (n) => fill('"\'', n),
  escapedQuotes: (n) => fill('\\\\\\"', n),
  bearerLetters: (n) => 'bearer ' + fill('a', n),
  manyTokenWords: (n) => fill('token ', n / 2) + fill('a', n / 2),
  percentRun: (n) => fill('%41', n),
  percentBad: (n) => fill('%E0%A4%A', n),
  htmlEntities: (n) => fill('&#61;', n),
  cookieLong: (n) => 'Cookie: ' + fill('a', n),
  authorizationRun: (n) => fill('authorization', n),
  urlColons: (n) => 'a://' + fill(':', n),
  urlUserLong: (n) => 'a://b:' + fill('c', n),
  schemeRun: (n) => fill('a', n) + '://',
  schemeCharsRun: (n) => fill('a+.-', n) + '://x',
  beginRun: (n) => fill('-----BEGIN RSA PRIVATE KEY-----\n', n),
  keyedJsonRun: (n) => fill('{"password":', n),
  eyjRun: (n) => fill('eyJ' + 'a'.repeat(12), n),
  deepJsonText: (n) => '['.repeat(n / 2) + ']'.repeat(n / 2),
};

function ms(f: () => unknown): number {
  const t = performance.now();
  f();
  return performance.now() - t;
}
/** One warm-up call (JIT, regex compilation), then the minimum of `runs`: the time least disturbed by GC or a
 *  busy machine. A call already over the ceiling is a stall and is not repeated. */
function best(f: () => unknown, runs = 5): number {
  let m = ms(f);
  if (m >= CEILING_MS) return m;
  m = Infinity;
  for (let i = 0; i < runs && !(m >= CEILING_MS && m < Infinity); i++) m = Math.min(m, ms(f));
  return m;
}
/** `f(n)` grows linearly from `small` to 2×`small` characters and never stalls. A pause from a busy machine
 *  can land in one measurement; a quadratic path is superlinear in EVERY measurement, so a ratio breach is
 *  re-measured (up to ATTEMPTS times) and fails only if it repeats each time. A ceiling breach fails at once. */
const ATTEMPTS = 3;
function assertLinear(label: string, small: number, f: (n: number) => unknown): void {
  let why = '';
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const tSmall = best(() => f(small));
    assert.ok(tSmall < CEILING_MS, `${label}: ${small / KB} KB ${tSmall.toFixed(1)} ms — over the ${CEILING_MS} ms ceiling`);
    const tLarge = best(() => f(small * 2));
    const ratio = tLarge / Math.max(tSmall, 0.01);
    why = `${label}: ${small / KB} KB ${tSmall.toFixed(1)} ms → ${(small * 2) / KB} KB ${tLarge.toFixed(1)} ms (×${ratio.toFixed(1)}, attempt ${attempt})`;
    assert.ok(tLarge < CEILING_MS, `${why} — over the ${CEILING_MS} ms ceiling`);
    if (tLarge < NOISE_FLOOR_MS || ratio < SCALE_MAX) return;
  }
  assert.fail(`${why} — grows faster than linear (limit ×${SCALE_MAX}) in all ${ATTEMPTS} measurements`);
}

test('redactSecrets: every adversarial input scales linearly up to the scan cap, and 200 KB stays bounded (the per-call path)', () => {
  assert.equal(REDACT_MAX_SCAN_CHARS, 64 * KB, 'the 32 KB → 64 KB window below is sized to the cap');
  for (const [name, make] of Object.entries(ADVERSARIAL)) {
    const inputs = new Map([32 * KB, 64 * KB].map((n) => [n, make(n)]));
    assertLinear(`redactSecrets(${name})`, 32 * KB, (n) => redactSecrets({ content: inputs.get(n)! }));
    // Past the cap the cost is bounded by the cap: 200 KB is a ceiling check.
    const big = make(KB200);
    const took = best(() => redactSecrets({ content: big }));
    assert.ok(took < CEILING_MS, `redactSecrets(${name}) at 200 KB: ${took.toFixed(1)} ms`);
  }
});

test('every SECRET_PATTERNS regex and scrubSecrets is linear on each input, 200 KB → 400 KB (the uncapped repository-read path)', () => {
  for (const [name, make] of Object.entries(ADVERSARIAL)) {
    const inputs = new Map([KB200, 2 * KB200].map((n) => [n, make(n)]));
    for (const { name: pattern, re } of SECRET_PATTERNS) {
      assertLinear(`${pattern} on ${name}`, KB200, (n) => inputs.get(n)!.replace(new RegExp(re.source, re.flags), ''));
    }
    assertLinear(`scrubSecrets(${name})`, KB200, (n) => scrubSecrets(inputs.get(n)!));
  }
});

test('probe 5: a realistic base64 tool result is scrubbed in linear time', () => {
  const inputs = new Map([32 * KB, 64 * KB, KB200].map((n) => [n, b64(n)]));
  const call = (n: number) => redactSecrets({ result: { content: [{ type: 'text', text: inputs.get(n)! }] } });
  assertLinear('base64 tool result', 32 * KB, call);
  const took = best(() => call(KB200));
  assert.ok(took < CEILING_MS, `200 KB: ${took.toFixed(1)} ms`);
});

test('size cap fails CLOSED: past REDACT_MAX_SCAN_CHARS the rest is withheld, never passed through', () => {
  const secret = 'Zq9-probe-secret-value12';
  const tail = `password=${secret}`;
  const long = 'x'.repeat(REDACT_MAX_SCAN_CHARS + 10) + tail;
  const out = redactSecrets(long);
  assert.ok(!out.includes(secret), 'a secret past the scan window is not shown');
  assert.ok(out.includes(REDACTED) && /not scanned — withheld/.test(out));
  assert.ok(out.length < REDACT_MAX_SCAN_CHARS + 200, 'the unscanned rest is dropped');
  // A 5 MB JSON string is not parsed whole: bounded time, and nothing past the window survives.
  const huge = JSON.stringify({ rows: Array.from({ length: 100_000 }, (_, i) => ({ i, password: secret, note: 'x'.repeat(20) })) });
  const took = ms(() => redactSecrets(huge));
  assert.ok(took < CEILING_MS, `5 MB JSON string: ${took.toFixed(1)} ms`);
  assert.ok(!redactSecrets(huge).includes(secret));
});

test('probe 3 (fail-open checks): malformed, escaped, encoded and entity-encoded secrets do not leak', () => {
  const X = 'Zq9-probe-secret-value12';
  const cases: Record<string, unknown> = {
    malformedTrailing: `{"password":"${X}",}`,
    malformedUnclosed: `{"password":"${X}"`,
    embeddedEscaped: `Error 400: {"detail":"{\\"password\\":\\"${X}\\"}"}`,
    tripleEscaped: JSON.stringify(JSON.stringify(JSON.stringify({ apiKey: X }))),
    jsonWithSpace: `  \n{"token":"${X}"}\n`,
    jsonArrayInText: `[1,{"secret":"${X}"}] trailing`,
    deepArrayString: JSON.stringify(JSON.parse('['.repeat(30) + `{"password":"${X}"}` + ']'.repeat(30))),
    pctTwice: encodeURIComponent(encodeURIComponent(`password=${X}`)),
    pctMixedBad: `%ZZ password%3D${X}`,
    pctBadSeq: `%E0%A4%A password%3D${X}`,
    plusInSecret: `password=${X}+abc`,
    unicodeEscape: `{"pass\\u0077ord":"${X}"}`,
    unicodeEscapeVal: { body: `{"pass\\u0077ord":"${X}"}` },
    keyHtmlEntity: `password&#61;${X}`,
    keyHtmlHexEntity: `password&#x3D;${X}`,
    cookieObj: { cookie: X },
    authUpper: `AUTHORIZATION: ${X}`,
    authJsonEsc: '{\\"Authorization\\":\\"Basic dTpw\\"}',
  };
  for (const [k, v] of Object.entries(cases)) {
    const out = JSON.stringify(redactSecrets(v));
    assert.equal(out.includes(X) || out.includes('dTpw'), false, `${k} leaks: ${out.slice(0, 160)}`);
  }
  // A JSON chain 10 strings deep is unwrapped and redacted, in bounded time.
  let chain: unknown = { password: X };
  for (let i = 0; i < 10; i++) chain = JSON.stringify(chain);
  const took = ms(() => redactSecrets(chain as string));
  assert.ok(took < CEILING_MS, `chain: ${took.toFixed(1)} ms`);
  assert.equal(JSON.stringify(redactSecrets(chain as string)).includes(X), false);
  assert.ok(!redactSecretText(`{"password":"${X}", "n": 1}`).includes(X));
});

test('percent decoding: each escape on its own (one bad escape does not stop the rest) and two rounds', () => {
  assert.ok(!scrubSecrets('%E0%A4%A then password%3DZq9-secret-value').text.includes('Zq9-secret-value'));
  assert.ok(!scrubSecrets('password%253DZq9-secret-value').text.includes('Zq9-secret-value'), '%253D → %3D → =');
  assert.equal(scrubSecrets('100%25 sure, see %7Ehome').redactions, 0, 'decoding alone redacts nothing');
});
