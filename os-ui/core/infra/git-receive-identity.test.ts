/* SPDX-License-Identifier: Apache-2.0
 * Copyright 2026 Borek Data Ventures UG (haftungsbeschränkt)
 *
 * FEATURE:    The receive validator refuses identity switches in pushed dbt code (WP-15; 10 F4).
 * USER STORY: As a data owner I want nobody to push a model that tries to become another user
 *             inside a run that acts as me.
 * ARCHITECTURE:
 * Unit contract of `identitySwitchShaped`. Trino 476 itself refuses the switch (tests/lakehouse/
 * impersonation.int.test.mjs, "SET SESSION AUTHORIZATION inside an impersonated session"); this is
 * the defence in depth at push time, so such a model never reaches a run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identitySwitchShaped } from '@core/infra/git-receive';

test('model SQL and config hooks that switch identity are refused, whatever the case or spacing', () => {
  const bad: [string, string][] = [
    ['models/gold/x.sql', "{{ config(pre_hook=\"SET SESSION AUTHORIZATION 'bob'\") }}\nselect 1"],
    ['models/gold/x.sql', "{{ config(post_hook=[\"set\\n  session   authorization bob\"]) }} select 1"],
    ['models/gold/x.sql', 'select 1; RESET SESSION AUTHORIZATION'],
    ['models/gold/x.sql', 'set role admin'],
    ['models/gold/x.sql', 'SET ROLE ALL IN iceberg'],
    ['models/gold/schema.yml', "models:\n  - name: x\n    config:\n      pre-hook: \"set session authorization 'bob'\""],
    ['dbt_project.yml', "on-run-start: [\"SET SESSION AUTHORIZATION 'x'\"]"],
  ];
  for (const [path, content] of bad) assert.match(identitySwitchShaped(path, content) ?? '', /identity/, `${path}: ${content}`);
});

test('the words inside a comment do not hide or trigger anything they should not', () => {
  // A comment cannot carry the statement past the check ...
  assert.ok(identitySwitchShaped('models/x.sql', '/* note */ set /* x */ session authorization bob'));
  // ... and a comment that only MENTIONS it is not a switch.
  assert.equal(identitySwitchShaped('models/x.sql', '-- we never use set role here\nselect 1'), null);
  assert.equal(identitySwitchShaped('models/x.sql', '/* session authorization is refused by the OS */ select 1'), null);
});

test('ordinary models, non-dbt files and column names pass', () => {
  assert.equal(identitySwitchShaped('models/x.sql', 'select role, session_id, authorization_code from t'), null);
  // A string literal is NOT exempt: a hook statement is itself a string (`pre_hook="…"`).
  assert.ok(identitySwitchShaped('models/x.sql', "select 'set role x' as label"));
  assert.equal(identitySwitchShaped('README.md', 'set role admin'), null, 'not a dbt file');
  assert.equal(identitySwitchShaped('models/x.sql', null), null);
});
