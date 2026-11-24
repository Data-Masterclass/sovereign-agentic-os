/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The secret scrubber is linear — it never blocks the event loop on an adversarial input
 * USER STORY: As an operator I want a connection tool result, an external MCP error or a Langfuse export
 *             of any shape to be scrubbed in bounded time, so one large or hostile payload cannot stall
 *             every request on the pod; and I want what was not scanned withheld, never passed through.
 * ARCHITECTURE: pure functions (`core/infra/trace-masking.ts`), timed with `performance.now()`. Each
 *   adversarial input is 200 KB and must finish under 100 ms — through `redactSecrets` (the per-call
 *   path, which caps one string at REDACT_MAX_SCAN_CHARS) AND through every SECRET_PATTERNS regex on
 *   the full text (the uncapped repository-read path). Includes the independent verifier's probes
 *   (probe3 / probe4 / probe5) and the fail-open cases of probe3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, REDACT_MAX_SCAN_CHARS, SECRET_PATTERNS, redactSecrets, redactSecretText, scrubSecrets } from '@core/infra/trace-masking';

const KB200 = 200 * 1024;
const BUDGET_MS = 100;
const fill = (unit: string, size = KB200) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
const b64 = (n: number) => Buffer.from('y'.repeat(Math.ceil((n * 3) / 4))).toString('base64').slice(0, n);

/** 200 KB adversarial inputs: runs that made a pattern restart at every offset, repeats, nesting. */
const ADVERSARIAL: Record<string, string> = {
  backslashes: fill('\\'),
  backslashQuote: fill('\\"'),
  letters: fill('a'),
  base64: b64(KB200),
  passwordRepeated: fill('password='),
  passwordBackslashes: 'password=' + fill('\\'),
  passwordQuotedBackslashes: 'password: \\' + fill('\\') + 'x',
  nestedQuotes: fill('"\''),
  escapedQuotes: fill('\\\\\\"'),
  bearerLetters: 'bearer ' + fill('a'),
  manyTokenWords: fill('token ', KB200 / 2) + fill('a', KB200 / 2),
  percentRun: fill('%41'),
  percentBad: fill('%E0%A4%A'),
  htmlEntities: fill('&#61;'),
  cookieLong: 'Cookie: ' + fill('a'),
  authorizationRun: fill('authorization'),
  urlColons: 'a://' + fill(':'),
  urlUserLong: 'a://b:' + fill('c'),
  schemeRun: fill('a') + '://',
  schemeCharsRun: fill('a+.-') + '://x',
  beginRun: fill('-----BEGIN RSA PRIVATE KEY-----\n'),
  keyedJsonRun: fill('{"password":'),
  eyjRun: fill('eyJ' + 'a'.repeat(12)),
  deepJsonText: '['.repeat(KB200 / 2) + ']'.repeat(KB200 / 2),
};

function ms(f: () => unknown): number {
  const t = performance.now();
  f();
  return performance.now() - t;
}

test('redactSecrets: every 200 KB adversarial input finishes under 100 ms (the per-call path)', () => {
  for (const [name, input] of Object.entries(ADVERSARIAL)) {
    const took = ms(() => redactSecrets({ content: input }));
    assert.ok(took < BUDGET_MS, `${name}: ${took.toFixed(1)} ms`);
  }
});

test('every SECRET_PATTERNS regex is linear: each on each 200 KB input under 100 ms (the uncapped repository-read path)', () => {
  for (const [name, input] of Object.entries(ADVERSARIAL)) {
    for (const { name: pattern, re } of SECRET_PATTERNS) {
      const took = ms(() => input.replace(new RegExp(re.source, re.flags), ''));
      assert.ok(took < BUDGET_MS, `${pattern} on ${name}: ${took.toFixed(1)} ms`);
    }
    const whole = ms(() => scrubSecrets(input));
    assert.ok(whole < BUDGET_MS * 3, `scrubSecrets(${name}): ${whole.toFixed(1)} ms`);
  }
});

test('probe 5: a realistic 200 KB base64 tool result is scrubbed fast', () => {
  const big = Buffer.from('y'.repeat(150_000)).toString('base64');
  const took = ms(() => redactSecrets({ result: { content: [{ type: 'text', text: big }] } }));
  assert.ok(took < BUDGET_MS, `${took.toFixed(1)} ms`);
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
  assert.ok(took < BUDGET_MS * 3, `5 MB JSON string: ${took.toFixed(1)} ms`);
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
  assert.ok(took < BUDGET_MS, `chain: ${took.toFixed(1)} ms`);
  assert.equal(JSON.stringify(redactSecrets(chain as string)).includes(X), false);
  assert.ok(!redactSecretText(`{"password":"${X}", "n": 1}`).includes(X));
});

test('percent decoding: each escape on its own (one bad escape does not stop the rest) and two rounds', () => {
  assert.ok(!scrubSecrets('%E0%A4%A then password%3DZq9-secret-value').text.includes('Zq9-secret-value'));
  assert.ok(!scrubSecrets('password%253DZq9-secret-value').text.includes('Zq9-secret-value'), '%253D → %3D → =');
  assert.equal(scrubSecrets('100%25 sure, see %7Ehome').redactions, 0, 'decoding alone redacts nothing');
});
