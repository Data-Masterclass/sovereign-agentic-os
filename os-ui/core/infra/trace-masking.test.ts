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
import { scrubPii, maskText, maskExportedAttribute, contentShape, DEFAULT_MASKING, normalizeMasking } from '@core/infra/trace-masking';

test('PII: an e-mail address is replaced; text around it is kept', () => {
  assert.equal(scrubPii('write to rae.k+news@example-corp.co.uk today'), 'write to [email] today');
});

test('PII: a valid IBAN (with or without spaces) is replaced; a wrong checksum is not', () => {
  assert.equal(scrubPii('pay DE89 3704 0044 0532 0130 00 now'), 'pay [iban] now');
  assert.equal(scrubPii('pay DE89370400440532013000 now'), 'pay [iban] now');
  assert.equal(scrubPii('pay GB82WEST12345698765432 now'), 'pay [iban] now');
  // NEGATIVE TWIN: same shape, checksum broken — an order reference, not an account.
  assert.equal(scrubPii('ref DE89 3704 0044 0532 0130 01 ok'), 'ref DE89 3704 0044 0532 0130 01 ok');
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
