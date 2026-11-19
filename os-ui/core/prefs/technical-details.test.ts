/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */

/**
 * Tests for the "Show technical details" opt-in: off by default, on only when the user
 * explicitly chose it, and off again for anything unreadable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TECHNICAL_DETAILS_DEFAULT,
  parseTechnicalDetails,
  serializeTechnicalDetails,
} from '@core/prefs/technical-details-pure';

test('technical details are OFF by default — nothing stored reads as off', () => {
  assert.equal(TECHNICAL_DETAILS_DEFAULT, false);
  assert.equal(parseTechnicalDetails(null), false);
  assert.equal(parseTechnicalDetails(undefined), false);
  assert.equal(parseTechnicalDetails(''), false);
});

test('an explicit choice round-trips: on stays on, off stays off', () => {
  assert.equal(parseTechnicalDetails(serializeTechnicalDetails(true)), true);
  assert.equal(parseTechnicalDetails(serializeTechnicalDetails(false)), false);
});

test('anything but the exact stored "on" value is off — never a truthy guess', () => {
  for (const junk of ['true', '1', 'ON', 'yes', ' on', 1, true, {}, []]) {
    assert.equal(parseTechnicalDetails(junk), false, `expected off for ${JSON.stringify(junk)}`);
  }
});
