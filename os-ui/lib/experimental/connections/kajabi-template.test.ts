/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  USER_FACING_TEMPLATE_KEYS,
  userFacingTemplates,
  templateByKey,
  isPersonalConnectable,
} from './schema.ts';
import { vendorStack } from './connector-stacks.ts';
import { installGuideFor } from './install-guides.ts';

test('the kajabi template exists as a user-facing service SaaS connector', () => {
  const t = templateByKey('kajabi-api');
  assert.ok(t, 'kajabi-api template is registered');
  assert.equal(t!.type, 'SaaS');
  assert.equal(t!.connector, 'saas');
  assert.equal(t!.auth, 'service');
  assert.equal(t!.endpointHint, 'https://api.kajabi.com');
  assert.equal(t!.secretKey, 'kajabi-client-credentials');
  assert.equal(isPersonalConnectable(t!), false, 'shared service-credential connector (Builder/Admin)');
});

test('kajabi IS user-facing (shows in the Supported Connectors gallery) with its own stack', () => {
  assert.ok(USER_FACING_TEMPLATE_KEYS.includes('kajabi-api'));
  assert.ok(userFacingTemplates().some((t) => t.key === 'kajabi-api'));
  assert.equal(vendorStack('kajabi-api'), 'kajabi');
});

test('the preset ships safe: reads Read, tag write Off (no live writer wired — C2), delete Blocked', () => {
  const t = templateByKey('kajabi-api')!;
  const byName = Object.fromEntries(t.tools.map((x) => [x.name, x]));
  for (const name of ['read_contact', 'read_purchase', 'list_offers']) {
    assert.equal(byName[name].mode, 'Read', `${name} is Read`);
    assert.equal(byName[name].write, false, `${name} is non-write`);
  }
  // C2(c): tag_contact is Off by default — no real Kajabi write executor is wired, so an
  // approved call would only execute a mocked write. It stays registered but uncallable.
  assert.equal(byName.tag_contact.mode, 'Off');
  assert.equal(byName.tag_contact.write, true);
  assert.equal(byName.delete_contact.mode, 'Blocked');
});

test('a REQUIRED installation guide is authored, with the honest per-resource caveat', () => {
  const g = installGuideFor('kajabi-api');
  assert.ok(g, 'guide exists (No guide → not shippable)');
  assert.ok(g!.prerequisites.length >= 3 && g!.steps.length >= 4);
  assert.match(g!.prerequisites.join(' '), /Settings → Public API/);
  assert.match(g!.caveat ?? '', /full-refresh only/i, 'honest degradation is stated');
  assert.match(g!.caveat ?? '', /Deletes are never detected/i);
  assert.match(g!.caveat ?? '', /no rate-limit contract/i);
});
