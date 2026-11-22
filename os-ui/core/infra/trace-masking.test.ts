/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    Trace masking — the PII patterns and the content shape the Langfuse mask applies
 * USER STORY: As a platform admin who switched masking on I want an e-mail address, a phone
 *             number, an IBAN or a card number to be replaced in anything the OS sends to
 *             Langfuse, and I want ids, timestamps and counts to stay exactly as they were, so
 *             that Monitoring keeps working.
 * ARCHITECTURE: pure functions (`core/infra/trace-masking.ts`). Each positive case has a negative
 *             twin: a look-alike that must NOT be replaced (a bad checksum, a timestamp, a UUID).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scrubPii, maskText, maskExportedAttribute, contentShape, contentOnly, DEFAULT_MASKING, normalizeMasking, UNKNOWN_MASKING } from '@core/infra/trace-masking';

test('PII: an e-mail address is replaced; text around it is kept', () => {
  assert.equal(scrubPii('write to rae.k+news@example-corp.co.uk today'), 'write to [email] today');
});

test('PII: a valid IBAN (with or without spaces) is replaced; a wrong checksum is not', () => {
  assert.equal(scrubPii('pay DE89 3704 0044 0532 0130 00 now'), 'pay [iban] now');
  assert.equal(scrubPii('pay DE89370400440532013000 now'), 'pay [iban] now');
  assert.equal(scrubPii('pay GB82WEST12345698765432 now'), 'pay [iban] now');
  // NEGATIVE TWIN: same shape, checksum broken — not an account, so never labelled an IBAN
  // (digit runs inside it may still be caught by the phone rule; that is a different pattern).
  assert.ok(!scrubPii('ref DE89 3704 0044 0532 0130 02 ok').includes('[iban]'));
  assert.equal(scrubPii('ref XY12ABCD34 ok'), 'ref XY12ABCD34 ok');
});

test('PII: a Luhn-valid card number is replaced; a Luhn-invalid one is not', () => {
  assert.equal(scrubPii('card 4111 1111 1111 1111 exp'), 'card [card] exp');
  assert.equal(scrubPii('card 4111-1111-1111-1111 exp'), 'card [card] exp');
  assert.equal(scrubPii('card 5500000000000004 exp'), 'card [card] exp');
  assert.equal(scrubPii('card 4111 1111 1111 1112 exp'), 'card 4111 1111 1111 1112 exp');
});

test('PII: a phone number (international or with separators) is replaced; bare ids and timestamps are not', () => {
  assert.equal(scrubPii('call +49 170 1234567 please'), 'call [phone] please');
  assert.equal(scrubPii('call (030) 1234-5678 please'), 'call [phone] please');
  assert.equal(scrubPii('call 0049 170 1234567 please'), 'call [phone] please');
  // NEGATIVE TWINS: an epoch in ms, a UUID, a token count, a date, a cost.
  const keep = 'at 1763800000000 id 0b1e28ba-2fa1-11d2-883f-0016d3cca427 tokens 15 on 2026-11-22 cost 0.000123';
  assert.equal(scrubPii(keep), keep);
});

test('PII: an IBAN is not eaten as a phone number first, and a card is not eaten as a phone', () => {
  assert.equal(scrubPii('DE89370400440532013000 / 4111 1111 1111 1111'), '[iban] / [card]');
});

test('maskExportedAttribute: walks the JSON the SDK hands over, keeps keys and non-string values', () => {
  const data = JSON.stringify({ task: 'mail rae@example.com', args: { iban: 'DE89370400440532013000', n: 3, ts: 1763800000000 }, list: ['+49 170 1234567', 'ok'] });
  const out = JSON.parse(maskExportedAttribute(data) as string);
  assert.deepEqual(out, { task: 'mail [email]', args: { iban: '[iban]', n: 3, ts: 1763800000000 }, list: ['[phone]', 'ok'] });
});

test('maskExportedAttribute: a value that is not JSON text is scrubbed as text; a non-string is returned as it is', () => {
  assert.equal(maskExportedAttribute('plain rae@example.com'), 'plain [email]');
  assert.equal(maskExportedAttribute(42), 42);
});

test('contentShape: a value becomes its size, never its text', () => {
  assert.deepEqual(contentShape('secret words'), { redacted: true, chars: 12 });
  assert.deepEqual(contentShape({ a: 'x' }), { redacted: true, chars: JSON.stringify({ a: 'x' }).length });
  assert.equal(contentShape(undefined), undefined);
});

test('normalizeMasking: default OFF at the PII level; only real values count', () => {
  assert.deepEqual(DEFAULT_MASKING, { enabled: false, level: 'pii' });
  assert.deepEqual(normalizeMasking({ enabled: true, level: 'content' }), { enabled: true, level: 'content' });
  assert.deepEqual(normalizeMasking({ enabled: 'yes', level: 'everything' }), { enabled: false, level: 'pii' });
  assert.deepEqual(normalizeMasking(undefined, { enabled: true, level: 'content' }), { enabled: true, level: 'content' });
  assert.deepEqual(normalizeMasking({ level: 'content' }, { enabled: true, level: 'pii' }), { enabled: true, level: 'content' });
});

test('maskText (free text such as a score comment): off keeps it, pii scrubs it, content drops it', () => {
  const t = 'judge saw rae@example.com';
  assert.equal(maskText(t, { enabled: false, level: 'pii' }), t);
  assert.equal(maskText(t, { enabled: true, level: 'pii' }), 'judge saw [email]');
  assert.equal(maskText(t, { enabled: true, level: 'content' }), undefined);
  assert.equal(maskText(undefined, { enabled: true, level: 'pii' }), undefined);
});

// ------------------------------------------------------------ regex misses --

test('PII: IBANs in lower case or with hyphens or mixed case are replaced whole, with no prefix left over', () => {
  for (const v of ['de89370400440532013000', 'de89 3704 0044 0532 0130 00', 'DE89-3704-0044-0532-0130-00', 'de89-3704-0044-0532-0130-00', 'De89 3704 0044 0532 0130 00', 'gb82west12345698765432']) {
    assert.equal(scrubPii(`pay ${v} now`), 'pay [iban] now', v);
  }
  // NEGATIVE TWINS: a lower-case or hyphenated look-alike with a broken checksum, and plain words.
  assert.ok(!scrubPii('ref de89-3704-0044-0532-0130-02 ok').includes('[iban]'));
  assert.equal(scrubPii('the cat sat on the mat and ate'), 'the cat sat on the mat and ate');
});

test('PII: unicode / IDN and quoted-local-part e-mail addresses are replaced', () => {
  for (const v of ['jürgen.müller@beispiel.de', 'мария@пример.рф', 'user@münchen.example', 'user@例え.jp', 'user@xn--mnchen-3ya.de', '"john doe"@example.com', '"a@b"@example.org', 'o\'brien@example.ie']) {
    assert.equal(scrubPii(`mail ${v} please`), 'mail [email] please', v);
  }
  assert.equal(scrubPii('mail Jürgen.Müller@Beispiel.DE.'), 'mail [email].', 'a trailing full stop stays outside');
  // NEGATIVE TWINS: an @ that is not an address.
  for (const keep of ['meet @ 5pm', 'twitter handle @maria_k', 'price 3 @ 4.50 each', 'user@localhost', 'a@b']) assert.equal(scrubPii(keep), keep, keep);
});

test('PII: phone numbers without +, 00 or a leading 0 and without a parenthesised area code are replaced', () => {
  for (const v of ['555-123-4567', '555.123.4567', '555 123 4567', '5551234567', '49 170 1234567', '01701234567', '0170 1234567', '+1 555 123 4567']) {
    assert.equal(scrubPii(`call ${v} please`), 'call [phone] please', v);
  }
});

test('PII NEGATIVE TWINS: dates, amounts, ids, ISO timestamps, versions, epochs and counts are NOT masked', () => {
  const keep = [
    'on 2026-11-22 and 22.11.2026 and 11/22/2026 and 20261122',
    'total 1,234,567.89 EUR and 1.234,56 and 12 345,67 and 1 234 567',
    'ids wf_01HXAB12CD34EF56 run_8c1f0f9e-1c2d-4e5f-8a9b-0c1d2e3f4a5b sys-mask-0001 ds_2026_11_22_17',
    'at 2026-11-22T09:17:03.123Z and 2026-11-22T09:17:03+01:00 and 2026-11-22 09:17:03',
    'langfuse 3.194.1 litellm 1.109.1 node 24.11.0 v10.2.3-rc.1',
    'epoch 1732267023 ms 1732267023000 tokens 15000 rows 1234567',
    'ip 192.168.100.200 and 255.255.255.255 port 14031',
    'hash 3f2a9c1b7d5e4a60 build 20261122091703',
  ].join(' | ');
  assert.equal(scrubPii(keep), keep);
});

// ----------------------------------------------------- content, structural --

test('contentOnly: text leaves become sizes, structural keys, numbers and booleans stay', () => {
  const out = contentOnly({ tool: 'query_data', decision: 'ok', callId: 'c-1', rows: 2, ok: true, sql: 'select secret from t', note: 'Keller account', path: ['reader', 'writer'], nested: { arg: 'Keller', model: 'gpt-x' } }) as Record<string, unknown>;
  assert.deepEqual(out, {
    tool: 'query_data', decision: 'ok', callId: 'c-1', rows: 2, ok: true,
    sql: { redacted: true, chars: 20 }, note: { redacted: true, chars: 14 }, path: ['reader', 'writer'],
    nested: { arg: { redacted: true, chars: 6 }, model: 'gpt-x' },
  });
  // NEGATIVE TWIN: an already-reduced shape is left alone (it carries no text).
  assert.deepEqual(contentOnly({ input: { redacted: true, chars: 9 } }), { input: { redacted: true, chars: 9 } });
  assert.deepEqual(contentOnly('free text'), { redacted: true, chars: 9 });
  assert.equal(contentOnly(undefined), undefined);
});

test('maskExportedAttribute with a content policy: any text the writer did not reduce is reduced at export', () => {
  const data = JSON.stringify({ task: 'Refund Keller', tool: 'query_data', n: 3 });
  const out = JSON.parse(maskExportedAttribute(data, { enabled: true, level: 'content' }) as string);
  assert.deepEqual(out, { task: { redacted: true, chars: 13 }, tool: 'query_data', n: 3 });
  // NEGATIVE TWINS: the pii level and no level keep the words (pii still scrubs personal data).
  assert.equal(JSON.parse(maskExportedAttribute(data, { enabled: true, level: 'pii' }) as string).task, 'Refund Keller');
  assert.equal(JSON.parse(maskExportedAttribute(data) as string).task, 'Refund Keller');
  assert.deepEqual(JSON.parse(maskExportedAttribute(JSON.stringify({ m: 'rae@example.com' }), { enabled: true, level: 'pii' }) as string), { m: '[email]' });
});

test('UNKNOWN_MASKING: not knowing the switch is the strictest policy', () => {
  assert.deepEqual(UNKNOWN_MASKING, { enabled: true, level: 'content' });
});
